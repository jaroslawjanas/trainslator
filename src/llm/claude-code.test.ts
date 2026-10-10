import { type SpawnOptions, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  makeConnection,
  makeModel,
  makeRuntime,
  makeStep,
  type TestRuntime,
} from "../testing/llm-fixtures.ts";
import { type CallSpec, callStructured } from "./call.ts";
import { claudeCodeArgs, fromClaudeCodeResult, useClaudeCodeSpawn } from "./claude-code.ts";
import type { LlmError } from "./errors.ts";
import { buildRequestBody, type RequestPlan } from "./request.ts";
import { toStrictJsonSchema } from "./structured.ts";

const Answer = z.object({ items: z.array(z.object({ id: z.string(), text: z.string() })) });
type Answer = z.infer<typeof Answer>;
const ANSWER = { items: [{ id: "u1", text: "Dzień dobry" }] };
const FAKE = path.join(import.meta.dirname, "../testing/fake-claude.ts");

const plan = (overrides: Partial<RequestPlan> = {}): RequestPlan => ({
  blocks: [
    { role: "system", label: "instructions", text: "Translate into Polish." },
    { role: "user", label: "book KB", text: "Mira → Mira", cacheBreakpoint: true },
    { role: "user", label: "units", text: '[{"id":"u1","text":"Good morning"}]' },
  ],
  schemaName: "translation",
  jsonSchema: toStrictJsonSchema(Answer),
  answerBudget: 500,
  reasoningAllowance: 0,
  turns: [],
  promptCacheKey: null,
  ...overrides,
});

const claudeCode = () => makeConnection("claude", { kind: "claude_code" });

describe("Claude Code requests", () => {
  it("puts the stable part in the system prompt and the rest in the prompt", () => {
    const body = buildRequestBody(
      claudeCode(),
      makeModel("claude_code", { modelName: "haiku" }),
      makeStep({ reasoning: { enabled: true, effort: "xhigh", budgetTokens: null } }),
      plan({ turns: [{ kind: "repair", previous: "{}", problems: "items: missing" }] }),
      true,
    );
    expect(body.system).toContain("Translate into Polish.");
    expect(body.system).toContain("Mira → Mira");
    expect(body.prompt).toContain('"Good morning"');
    expect(body.prompt).not.toContain("Mira → Mira");
    // A follow-up turn is written into the prompt.
    expect(body.prompt).toContain("# Your previous answer\n{}");
    expect(body.prompt).toContain("items: missing");
    expect(body).toMatchObject({ model: "haiku", effort: "xhigh", stream: true });

    const args = claudeCodeArgs(body, "sys.txt");
    expect(args).toEqual(
      expect.arrayContaining(["-p", "--safe-mode", "--no-session-persistence", "--model", "haiku"]),
    );
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(
      args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2),
    ).toEqual(["--output-format", "stream-json"]);
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toMatchObject({ type: "object" });
  });

  it("sends low effort for 'reasoning off' and maps efforts Claude Code lacks", () => {
    const off = buildRequestBody(claudeCode(), makeModel("claude_code"), makeStep(), plan(), false);
    expect(claudeCodeArgs(off, "s")).toEqual(expect.arrayContaining(["--effort", "low"]));
    const minimal = buildRequestBody(
      claudeCode(),
      makeModel("claude_code"),
      makeStep({ reasoning: { enabled: true, effort: "minimal", budgetTokens: null } }),
      plan(),
      false,
    );
    expect(claudeCodeArgs(minimal, "s")).toEqual(expect.arrayContaining(["--effort", "low"]));
  });

  it("reads the result, usage and the structured answer", () => {
    const raw = fromClaudeCodeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ignored",
      structured_output: ANSWER,
      stop_reason: "tool_use",
      total_cost_usd: 0.0005,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 917,
        cache_read_input_tokens: 581,
        output_tokens: 344,
        output_tokens_details: { thinking_tokens: 120 },
      },
      modelUsage: { "claude-haiku-5-5": {} },
    });
    expect(JSON.parse(raw.content)).toEqual(ANSWER);
    expect(raw).toMatchObject({
      finishReason: "stop",
      model: "claude-haiku-5-5",
      usage: {
        promptTokens: 1500,
        cachedTokens: 581,
        cacheWriteTokens: 917,
        completionTokens: 344,
        reasoningTokens: 120,
        cost: 0,
      },
    });
  });

  it("explains a missing login and stops the job when the subscription's limit is reached", () => {
    const error = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as LlmError;
      }
      throw new Error("no error");
    };
    const auth = error(() =>
      fromClaudeCodeResult({ is_error: true, result: "Invalid API key · Please run /login" }),
    );
    expect(auth.kind).toBe("auth");
    const later = Math.floor(Date.now() / 1000) + 3 * 3600;
    const limit = error(() =>
      fromClaudeCodeResult(
        { is_error: true, api_error_status: 429, result: "Claude AI usage limit reached" },
        { rateLimit: { status: "rejected", resetsAt: later } },
      ),
    );
    expect(limit.kind).toBe("config");
    expect(limit.message).toContain("usage limit is reached");
    const brief = error(() =>
      fromClaudeCodeResult({ is_error: true, api_error_status: 429, result: "rate limited" }),
    );
    expect(brief.kind).toBe("rate_limit");
  });
});

describe("running Claude Code", () => {
  let env: TestRuntime | null = null;
  let log = "";
  let config: Record<string, unknown> = {};
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    log = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "fake-claude-")), "log.json");
    config = {};
    process.env.ANTHROPIC_API_KEY = "sk-should-not-be-used";
    // The fake program instead of the real one, with the environment the app prepared.
    useClaudeCodeSpawn(((_command: string, args: string[], options: SpawnOptions) =>
      spawn(process.execPath, [FAKE, ...args], {
        ...options,
        env: { ...options.env, FAKE_CLAUDE: JSON.stringify({ log, ...config }) },
      })) as unknown as typeof spawn);
  });
  afterEach(async () => {
    useClaudeCodeSpawn(null);
    await env?.cleanup();
    env = null;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  async function call(stream: boolean) {
    const connection = makeConnection("claude", { kind: "claude_code", stream });
    const model = makeModel("claude_code", { modelName: "haiku" });
    env = await makeRuntime(connection, model);
    const spec: CallSpec<Answer> = {
      projectId: "pr_test",
      step: "phase3.translate",
      label: "test",
      blocks: plan().blocks,
      schema: Answer,
      schemaName: "translation",
      answerBudget: 500,
      useCache: false,
    };
    return callStructured(env.rt, { connection, model, step: makeStep() }, spec);
  }

  it.each([false, true])("translates through claude -p (streaming %s)", async (stream) => {
    config = { reply: ANSWER };
    const result = await call(stream);
    expect(result.value).toEqual(ANSWER);
    // Tokens are counted, but the subscription pays: no cost.
    expect(result.usage).toMatchObject({ cachedTokens: 600, reasoningTokens: 25, cost: 0 });
    const seen = JSON.parse(await fs.readFile(log, "utf8"));
    expect(seen.system).toContain("Mira → Mira");
    expect(seen.stdin).toContain('"Good morning"');
    // The subscription, never an API key, and not as part of a Claude Code session.
    expect(seen.apiKeyInEnv).toBe(false);
    expect(seen.nested).toBe(false);
  });

  it("reports a missing login clearly", async () => {
    config = { error: { result: "Not logged in · Please run /login" } };
    await expect(call(true)).rejects.toMatchObject({ kind: "auth" });
  });
});
