import { afterEach, describe, expect, it } from "vitest";
import { type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
import {
  makeConnection,
  makeModel,
  makeRuntime,
  type TestRuntime,
} from "../testing/llm-fixtures.ts";
import { listModels, testModel } from "./probe.ts";

let server: FakeServer | null = null;
let env: TestRuntime | null = null;
afterEach(async () => {
  await server?.close();
  await env?.cleanup();
});

const GOOD = JSON.stringify({
  zq_probe_ok: true,
  edits: [
    {
      op: "add",
      id: null,
      fields: { kind: "person", source: "Mira", target: "Mira", attributes: [] },
      reason: "test",
    },
  ],
});

describe("test connection", () => {
  it("lists models and reports a working connection", async () => {
    server = await startFakeOpenAI(() => ({ content: GOOD }));
    const connection = makeConnection(server.url);
    env = await makeRuntime(connection, makeModel("openai"));
    expect((await listModels(env.rt, connection)).map((m) => m.id)).toEqual(["fake-model"]);
    const report = await testModel(env.rt, connection, makeModel("openai"));
    expect(report.checks.find((c) => c.name === "Structured output")?.ok).toBe(true);
    expect(report.suggestions).toEqual({});
  });

  it("switches the length parameter when the provider rejects it", async () => {
    server = await startFakeOpenAI((body) =>
      "max_completion_tokens" in body
        ? { status: 400, errorMessage: "Unsupported parameter: max_completion_tokens" }
        : { content: GOOD },
    );
    const connection = makeConnection(server.url);
    env = await makeRuntime(connection, makeModel("openai"));
    const report = await testModel(env.rt, connection, makeModel("openai"));
    expect(report.suggestions.maxTokensParam).toBe("max_tokens");
    expect(report.checks[0]?.ok).toBe(true);
  });

  it("leaves room for models that reason even when asked not to", async () => {
    server = await startFakeOpenAI(() => ({ content: GOOD }));
    const connection = makeConnection(server.url);
    env = await makeRuntime(connection, makeModel("openai"));
    await testModel(env.rt, connection, makeModel("openai"));
    expect(Number(server.requests[0]!.max_completion_tokens)).toBe(4400);
  });

  it("reports an answer cut off at the limit as cut off, not as broken JSON", async () => {
    server = await startFakeOpenAI(() => ({
      content: '{"zq_probe_ok": true, "edits": [{"op": "add", "fields": {"kind',
      finishReason: "length",
    }));
    const connection = makeConnection(server.url);
    env = await makeRuntime(connection, makeModel("openai"));
    const report = await testModel(env.rt, connection, makeModel("openai"));
    const check = report.checks.find((c) => c.name === "Structured output");
    expect(check).toMatchObject({ ok: null });
    expect(check?.detail).toContain("cut off");
    expect(report.suggestions.structuredOutput).toBeUndefined();
  });

  it("checks that the model calls tools, which it needs to consult the advisor", async () => {
    server = await startFakeOpenAI((body) =>
      body.tools
        ? { toolCalls: [{ id: "c1", name: "ask_advisor", arguments: '{"question": "?"}' }] }
        : { content: GOOD },
    );
    const connection = makeConnection(server.url);
    env = await makeRuntime(connection, makeModel("openai"));
    const report = await testModel(env.rt, connection, makeModel("openai"));
    expect(report.checks.find((c) => c.name === "Tool calls")?.ok).toBe(true);
  });

  it("notices when response_format is silently ignored", async () => {
    server = await startFakeOpenAI(() => ({ content: '{"edits": []}' }));
    const connection = makeConnection(server.url);
    env = await makeRuntime(connection, makeModel("openai"));
    const report = await testModel(env.rt, connection, makeModel("openai"));
    expect(report.suggestions.structuredOutput).toBe("none");
  });
});
