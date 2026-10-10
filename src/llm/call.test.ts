import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Connection, Model, StepSettings } from "../shared/schemas/settings.ts";
import { type FakeHandler, type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
import {
  makeConnection,
  makeModel,
  makeRuntime,
  makeStep,
  type TestRuntime,
} from "../testing/llm-fixtures.ts";
import { type CallSpec, callStructured } from "./call.ts";
import { LlmError } from "./errors.ts";

const Answer = z.object({ items: z.array(z.object({ id: z.string(), text: z.string() })) });
type Answer = z.infer<typeof Answer>;

const VALID = JSON.stringify({ items: [{ id: "u1", text: "Dzień dobry" }] });

let server: FakeServer | null = null;
let env: TestRuntime | null = null;

afterEach(async () => {
  await server?.close();
  await env?.cleanup();
  server = null;
  env = null;
});

async function setup(
  handler: FakeHandler,
  conn: Partial<Connection> = {},
  model: Partial<Model> = {},
  kind: Parameters<typeof makeModel>[0] = "openai",
) {
  server = await startFakeOpenAI(handler);
  const connection = makeConnection(server.url, { kind, ...conn });
  const m = makeModel(kind, model);
  env = await makeRuntime(connection, m);
  return { connection, model: m };
}

function spec(overrides: Partial<CallSpec<Answer>> = {}): CallSpec<Answer> {
  return {
    projectId: "pr_test",
    step: "phase3.translate",
    label: "test",
    blocks: [
      { role: "system", label: "instructions", text: "Translate into Polish." },
      { role: "user", label: "chunk", text: '[{"id":"u1","text":"Good morning"}]' },
    ],
    schema: Answer,
    schemaName: "translation",
    answerBudget: 500,
    useCache: false,
    ...overrides,
  };
}

async function call(s: CallSpec<Answer> = spec(), step: StepSettings = makeStep()) {
  const settings = env!.settings;
  return callStructured(
    env!.rt,
    { connection: settings.connections[0]!, model: settings.models[0]!, step },
    s,
  );
}

describe("callStructured", () => {
  it("returns validated output and sends a strict JSON schema", async () => {
    await setup(() => ({ content: VALID }));
    const result = await call();
    expect(result.value.items[0]!.text).toBe("Dzień dobry");
    expect(result.attempts).toBe(1);
    const body = server!.requests[0]!;
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
    expect(body.max_completion_tokens).toBe(500);
  });

  it("reads streamed answers with usage in a final chunk or on the last content chunk", async () => {
    await setup(
      () => ({
        content: VALID,
        usage: {
          prompt_tokens: 50,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
      { stream: true },
    );
    const a = await call();
    expect(a.usage).toMatchObject({
      promptTokens: 50,
      cachedTokens: 40,
      completionTokens: 10,
      estimated: false,
    });
    await server!.close();
    await env!.cleanup();
    await setup(
      () => ({
        content: VALID,
        usageOnLastContentChunk: true,
        usage: { prompt_tokens: 60, completion_tokens: 12, prompt_cache_hit_tokens: 30 },
      }),
      { stream: true },
      {},
      "deepseek",
    );
    const b = await call();
    expect(b.usage).toMatchObject({ promptTokens: 60, cachedTokens: 30 });
  });

  it("ignores leaked reasoning and preambles", async () => {
    await setup(() => ({
      content: `Okay, the user wants {"x":1}</think>\nSure! Here it is:\n\`\`\`json\n${VALID}\n\`\`\``,
    }));
    expect((await call()).value.items).toHaveLength(1);
  });

  it("asks for a repair when the output is invalid", async () => {
    await setup((_b, i) => ({ content: i === 0 ? '{"items": [{"id": "u1"}]}' : VALID }));
    const result = await call();
    expect(result.attempts).toBe(2);
    const messages = server!.requests[1]!.messages as { role: string; content: string }[];
    expect(messages.at(-2)!.role).toBe("assistant");
    expect(messages.at(-1)!.content).toContain("items.0.text");
  });

  it("runs the step's own checks and repairs with their problems", async () => {
    await setup((_b, i) => ({
      content: i === 0 ? JSON.stringify({ items: [{ id: "u9", text: "x" }] }) : VALID,
    }));
    const result = await call(
      spec({ validate: (v) => (v.items[0]?.id === "u1" ? [] : ["id u1 is missing"]) }),
    );
    expect(result.attempts).toBe(2);
    expect((server!.requests[1]!.messages as { content: string }[]).at(-1)!.content).toContain(
      "id u1 is missing",
    );
  });

  it("uses the step's salvage instead of a repair turn when it finds something usable", async () => {
    await setup(() => ({ content: '{"items": [{"id": "u1"}, {"id": "u2", "text": "ok"}]}' }));
    const result = await call(
      spec({
        salvage: (raw) => {
          const items = (JSON.parse(raw) as { items: { id: string; text?: string }[] }).items;
          const good = items.filter((i): i is { id: string; text: string } => !!i.text);
          return good.length > 0 ? { items: good } : null;
        },
      }),
    );
    expect(result.value).toEqual({ items: [{ id: "u2", text: "ok" }] });
    expect(server!.requests).toHaveLength(1);
  });

  it("gives up after two repair turns", async () => {
    await setup(() => ({ content: "no json here" }));
    await expect(call()).rejects.toMatchObject({ kind: "invalid_output" });
    expect(server!.requests).toHaveLength(3);
  });

  it("retries a refusal once, then reports it", async () => {
    await setup(() => ({ content: "", refusal: "I can't help with that." }));
    await expect(call()).rejects.toMatchObject({ kind: "refusal" });
    expect(server!.requests).toHaveLength(2);
  });

  it("raises the limit once when reasoning used up the output, then gives up", async () => {
    await setup(() => ({
      content: "",
      finishReason: "length",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 500,
        completion_tokens_details: { reasoning_tokens: 500 },
      },
    }));
    await expect(call()).rejects.toMatchObject({ kind: "reasoning_exhausted" });
    expect(server!.requests).toHaveLength(2);
    expect(Number(server!.requests[1]!.max_completion_tokens)).toBeGreaterThan(
      Number(server!.requests[0]!.max_completion_tokens),
    );
  });

  it("reports a cut-off answer as truncated", async () => {
    await setup(() => ({ content: '{"items": [{"id": "u1", "te', finishReason: "length" }));
    await expect(call()).rejects.toMatchObject({ kind: "truncated" });
  });

  it("waits and retries after rate limits", async () => {
    await setup((_b, i) =>
      i < 2 ? { status: 429, headers: { "retry-after": "0" } } : { content: VALID },
    );
    const result = await call();
    expect(result.value.items).toHaveLength(1);
    expect(server!.requests).toHaveLength(3);
  });

  it("retries when a stream breaks halfway", async () => {
    await setup(
      (_b, i) => (i === 0 ? { content: VALID, breakMidStream: true } : { content: VALID }),
      { stream: true },
    );
    expect((await call()).value.items).toHaveLength(1);
    expect(server!.requests).toHaveLength(2);
  });

  it("aborts a stream that goes silent", async () => {
    await setup(() => ({ content: VALID, chunkDelayMs: 1500 }), {
      stream: true,
      idleTimeoutSec: 1,
    });
    await expect(call()).rejects.toMatchObject({ kind: "transport" });
  });

  it("refuses prompts that can't fit the context window", async () => {
    await setup(() => ({ content: VALID }), {}, { contextWindow: 300 });
    await expect(call()).rejects.toMatchObject({ kind: "context_overflow" });
    expect(server!.requests).toHaveLength(0);
  });

  it("answers identical requests from the cache", async () => {
    await setup(() => ({ content: VALID }));
    await call(spec({ useCache: true }));
    const second = await call(spec({ useCache: true }));
    expect(second.fromCache).toBe(true);
    expect(server!.requests).toHaveLength(1);
  });

  it("keeps parallel requests within the model's limit", async () => {
    await setup(() => ({ content: VALID, delayMs: 60 }), {}, { maxParallel: 2 });
    await Promise.all(Array.from({ length: 6 }, () => call()));
    expect(server!.maxConcurrent).toBe(2);
  });

  it("does not retry authentication errors", async () => {
    await setup(() => ({ status: 401, errorMessage: "bad key" }));
    const error = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe("auth");
    expect(server!.requests).toHaveLength(1);
  });

  it("can be cancelled while waiting", async () => {
    await setup(() => ({ content: VALID, delayMs: 2000 }));
    const controller = new AbortController();
    const pending = call(spec({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("logs each request with usage", async () => {
    await setup(() => ({ content: VALID }));
    await call();
    const entries = await env!.rt.log.read("pr_test");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ step: "phase3.translate", kind: "request", error: null });
    expect(entries[0]!.blockTokens.map((b) => b.label)).toEqual(["instructions", "chunk"]);
  });
});
