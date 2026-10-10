import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConnectionKind } from "../shared/schemas/settings.ts";
import {
  makeConnection,
  makeModel,
  makeRuntime,
  makeStep,
  type TestRuntime,
} from "../testing/llm-fixtures.ts";
import { type CallSpec, callStructured } from "./call.ts";
import { LlmError } from "./errors.ts";
import { listModels } from "./probe.ts";

/** Ollama's and Anthropic's own APIs, against small fake servers. */

const Answer = z.object({ items: z.array(z.object({ id: z.string(), text: z.string() })) });
type Answer = z.infer<typeof Answer>;
const VALID = JSON.stringify({ items: [{ id: "u1", text: "Dzień dobry" }] });

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}
type Handler = (req: Seen, res: http.ServerResponse, index: number) => void;

let server: http.Server | null = null;
let env: TestRuntime | null = null;
let seen: Seen[] = [];

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  await env?.cleanup();
  server = null;
  env = null;
  seen = [];
});

async function setup(kind: ConnectionKind, handler: Handler, stream = false) {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const s: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      seen.push(s);
      handler(s, res, seen.length - 1);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const connection = makeConnection(url, { kind, stream });
  const model = makeModel(kind);
  env = await makeRuntime(connection, model);
  return { connection, model };
}

function spec(overrides: Partial<CallSpec<Answer>> = {}): CallSpec<Answer> {
  return {
    projectId: "pr_test",
    step: "phase3.translate",
    label: "test",
    blocks: [
      { role: "system", label: "instructions", text: "Translate into Polish." },
      { role: "user", label: "chunk", text: "Good morning", cacheBreakpoint: true },
    ],
    schema: Answer,
    schemaName: "translation",
    answerBudget: 500,
    useCache: false,
    ...overrides,
  };
}

function call(s: CallSpec<Answer> = spec()) {
  const settings = env!.settings;
  return callStructured(
    env!.rt,
    { connection: settings.connections[0]!, model: settings.models[0]!, step: makeStep() },
    s,
  );
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("Ollama's own API", () => {
  it("streams /api/chat line by line, with thinking and token counts", async () => {
    await setup(
      "ollama",
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const half = Math.floor(VALID.length / 2);
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: "", thinking: "Hmm." }, done: false })}\n`,
        );
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: VALID.slice(0, half) }, done: false })}\n`,
        );
        // A line split across two network chunks.
        const tail = JSON.stringify({
          message: { role: "assistant", content: VALID.slice(half) },
          done: false,
        });
        res.write(tail.slice(0, 10));
        res.write(`${tail.slice(10)}\n`);
        res.end(
          `${JSON.stringify({ model: "fake-model", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 42, eval_count: 17 })}\n`,
        );
      },
      true,
    );
    const result = await call();
    expect(result.value.items[0]!.text).toBe("Dzień dobry");
    expect(result.usage).toMatchObject({ promptTokens: 42, completionTokens: 17 });
    const req = seen[0]!;
    expect(req.path).toBe("/api/chat");
    expect(req.headers.authorization).toBe("Bearer test-key");
    expect(req.body).toMatchObject({
      stream: true,
      think: false,
      options: { num_predict: 500, num_ctx: 32_000 },
      format: { type: "object" },
    });
  });

  it("reports Ollama's errors with their message, without retrying them", async () => {
    await setup("ollama", (_req, res) =>
      json(res, 404, { error: "model 'fake-model' not found, try pulling it first" }),
    );
    const error = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: "bad_request" });
    expect((error as LlmError).message).toContain("not found");
    expect(seen).toHaveLength(1);
  });

  it("lists models from /api/tags", async () => {
    await setup("ollama_cloud", (_req, res) =>
      json(res, 200, { models: [{ name: "gpt-oss:120b" }, { name: "deepseek-v4.1-flash" }] }),
    );
    const models = await listModels(env!.rt, env!.settings.connections[0]!);
    expect(models.map((m) => m.id)).toEqual(["deepseek-v4.1-flash", "gpt-oss:120b"]);
    expect(seen[0]!.path).toBe("/api/tags");
  });
});

function message(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "fake-model",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: "standard",
    },
    ...extra,
  };
}

function sse(res: http.ServerResponse, events: [string, unknown][]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events)
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

describe("Anthropic's Messages API", () => {
  it("sends system blocks, cache breakpoints and the JSON schema, and maps usage", async () => {
    await setup("anthropic", (_req, res) =>
      json(res, 200, message([{ type: "text", text: VALID }])),
    );
    const result = await call();
    expect(result.value.items[0]!.text).toBe("Dzień dobry");
    // input_tokens is only the uncached part of the prompt.
    expect(result.usage).toMatchObject({
      promptTokens: 115,
      cachedTokens: 100,
      cacheWriteTokens: 5,
      completionTokens: 20,
    });
    const req = seen[0]!;
    expect(req.path).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("test-key");
    expect(req.headers["anthropic-version"]).toBeTruthy();
    expect(req.body).toMatchObject({
      model: "fake-model",
      output_config: { format: { type: "json_schema" } },
      messages: [
        {
          role: "user",
          content: [{ type: "text", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
    expect((req.body.system as unknown[]).length).toBe(2);
  });

  it("reads a streamed answer", async () => {
    const half = Math.floor(VALID.length / 2);
    await setup(
      "anthropic",
      (_req, res) =>
        sse(res, [
          ["message_start", { type: "message_start", message: message([], { stop_reason: null }) }],
          [
            "content_block_start",
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: VALID.slice(0, half) },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: VALID.slice(half) },
            },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
              usage: { output_tokens: 33 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ]),
      true,
    );
    const result = await call();
    expect(result.value.items[0]!.text).toBe("Dzień dobry");
    expect(result.usage.completionTokens).toBe(33);
    expect(seen[0]!.body.stream).toBe(true);
  });

  it("treats a refusal as a refusal: one retry, then it gives up", async () => {
    await setup("anthropic", (_req, res) =>
      json(
        res,
        200,
        message([], {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: null, explanation: "Declined." },
        }),
      ),
    );
    await expect(call()).rejects.toMatchObject({ kind: "refusal" });
    expect(seen).toHaveLength(2);
  });

  it("waits and retries when rate limited", async () => {
    await setup("anthropic", (_req, res, i) =>
      i === 0
        ? json(res, 429, {
            type: "error",
            error: { type: "rate_limit_error", message: "Slow down" },
          })
        : json(res, 200, message([{ type: "text", text: VALID }])),
    );
    const result = await call();
    expect(result.attempts).toBe(2);
  });

  it("lists models with their limits and known prices", async () => {
    await setup("anthropic", (_req, res) =>
      json(res, 200, {
        data: [
          {
            type: "model",
            id: "claude-opus-5-5",
            display_name: "Claude Opus 5.5",
            created_at: "2026-01-01T00:00:00Z",
            max_input_tokens: 1_000_000,
            max_tokens: 128_000,
          },
        ],
        has_more: false,
        first_id: "claude-opus-5-5",
        last_id: "claude-opus-5-5",
      }),
    );
    const models = await listModels(env!.rt, env!.settings.connections[0]!);
    expect(models[0]).toMatchObject({
      id: "claude-opus-5-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: { inputPerM: 4, outputPerM: 20 },
    });
  });
});
