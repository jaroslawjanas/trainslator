import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeConnection, makeModel, makeStep } from "../testing/llm-fixtures.ts";
import { thinkingRoomFactor } from "./presets.ts";
import { buildRequestBody, outputLimit, type RequestPlan } from "./request.ts";
import { toStrictJsonSchema } from "./structured.ts";
import { reasoningAllowance } from "./tokens.ts";

const schema = toStrictJsonSchema(z.object({ answer: z.string() }));

function plan(overrides: Partial<RequestPlan> = {}): RequestPlan {
  return {
    blocks: [
      { role: "system", label: "instructions", text: "You translate." },
      { role: "user", label: "reference", text: "KB", cacheBreakpoint: true },
      { role: "user", label: "chunk", text: "Hello" },
    ],
    schemaName: "answer",
    jsonSchema: schema,
    answerBudget: 1000,
    reasoningAllowance: 0,
    turns: [],
    promptCacheKey: "pk",
    ...overrides,
  };
}

describe("request bodies", () => {
  it("builds an OpenAI-style strict JSON schema request", () => {
    const body = buildRequestBody(
      makeConnection("http://x", { kind: "openai" }),
      makeModel("openai"),
      makeStep(),
      plan(),
      true,
    );
    expect(body).toMatchObject({
      model: "fake-model",
      max_completion_tokens: 1000,
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true } },
      prompt_cache_key: "pk",
      stream: true,
      stream_options: { include_usage: true },
    });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0]!.content.startsWith("You translate.\n\n")).toBe(true);
    // The structure is described in the prompt even when response_format is used.
    expect(messages[0]!.content).toContain('"answer": string');
    expect(messages[1]!.content).toBe("KB\n\nHello\n\n");
    expect(body.temperature).toBeUndefined();
  });

  it("describes the schema in the prompt for json_object models", () => {
    const body = buildRequestBody(
      makeConnection("http://x"),
      makeModel("deepseek"),
      makeStep(),
      plan(),
      false,
    );
    expect(body.response_format).toEqual({ type: "json_object" });
    const system = (body.messages as { content: string }[])[0]!.content;
    expect(system).toContain("Respond with a single JSON object");
    expect(system).toContain('"answer": string');
  });

  it("sends reasoning templates for on and off, with substitutions", () => {
    const deepseek = makeModel("deepseek");
    const off = buildRequestBody(makeConnection("http://x"), deepseek, makeStep(), plan(), false);
    expect(off.thinking).toEqual({ type: "disabled" });
    const budgeted = makeModel("custom", {
      reasoningTemplates: {
        onEnabled: { thinking: { type: "enabled", budget_tokens: "{{budget}}" } },
        onDisabled: null,
      },
    });
    const on = buildRequestBody(
      makeConnection("http://x"),
      budgeted,
      makeStep({ reasoning: { enabled: true, effort: null, budgetTokens: 3000 } }),
      plan({ reasoningAllowance: 3000 }),
      false,
    );
    expect(on.thinking).toEqual({ type: "enabled", budget_tokens: 3000 });
    expect(on.max_tokens).toBe(4000);
  });

  it("adds explicit cache markers as content parts", () => {
    const model = makeModel("openrouter", { cacheMarkers: "anthropic" });
    const body = buildRequestBody(
      makeConnection("http://x", { kind: "openrouter" }),
      model,
      makeStep(),
      plan(),
      false,
    );
    const user = (body.messages as { content: { text: string; cache_control?: unknown }[] }[])[1]!
      .content;
    expect(user[0]).toEqual({ type: "text", text: "KB\n\n", cache_control: { type: "ephemeral" } });
    expect(user[1]).toEqual({ type: "text", text: "Hello\n\n" });
    expect(body.provider).toEqual({ require_parameters: true });
  });

  it("merges extra body parameters last and appends repair turns", () => {
    const body = buildRequestBody(
      makeConnection("http://x"),
      makeModel(),
      makeStep({ temperature: 0.3, extraBody: { top_p: 0.9, response_format: { type: "text" } } }),
      plan({ turns: [{ kind: "repair", previous: "{}", problems: "missing answer" }] }),
      false,
    );
    expect(body.top_p).toBe(0.9);
    expect(body.temperature).toBe(0.3);
    expect(body.response_format).toEqual({ type: "text" });
    const messages = body.messages as { role: string }[];
    expect(messages.slice(-2).map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  it("caps the output limit by the model and the step", () => {
    const body = buildRequestBody(
      makeConnection("http://x"),
      makeModel("custom", { maxOutputTokens: 500 }),
      makeStep(),
      plan(),
      false,
    );
    expect(body.max_tokens).toBe(500);
  });
});

describe("native request bodies", () => {
  it("builds an Ollama /api/chat body with num_predict, num_ctx and the schema", () => {
    const local = buildRequestBody(
      makeConnection("http://localhost:11434", { kind: "ollama" }),
      makeModel("ollama", { contextWindow: 32_768 }),
      makeStep({ temperature: 0.3 }),
      plan({ turns: [{ kind: "repair", previous: "{}", problems: "missing answer" }] }),
      true,
    );
    expect(local).toMatchObject({
      model: "fake-model",
      stream: true,
      format: schema,
      think: false,
      options: { num_predict: 1000, num_ctx: 32_768, temperature: 0.3 },
    });
    const messages = local.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[0]!.content).toContain("You translate.");
    expect(messages[0]!.content).toContain("Respond with a single JSON object");
    expect(messages[1]!.content).toBe("KB\n\nHello\n\n");

    // Ollama Cloud manages the context size itself.
    const cloud = buildRequestBody(
      makeConnection("https://ollama.com", { kind: "ollama_cloud" }),
      makeModel("ollama_cloud"),
      makeStep({ reasoning: { enabled: true, effort: "high", budgetTokens: null } }),
      plan(),
      false,
    );
    expect((cloud.options as Record<string, unknown>).num_ctx).toBeUndefined();
    const suffixed = buildRequestBody(
      makeConnection("https://ollama.com", { kind: "ollama_cloud" }),
      makeModel("ollama_cloud", { modelName: "deepseek-v4.1-flash:cloud" }),
      makeStep(),
      plan(),
      false,
    );
    expect(suffixed.model).toBe("deepseek-v4.1-flash");
    expect(cloud.stream).toBe(false);
  });

  it("sends the reasoning effort to Ollama as the nearest thinking level", () => {
    const think = (effort: string | null) =>
      buildRequestBody(
        makeConnection("https://ollama.com", { kind: "ollama_cloud" }),
        makeModel("ollama_cloud"),
        makeStep({ reasoning: { enabled: true, effort, budgetTokens: null } }),
        plan(),
        false,
      ).think;
    expect([think("minimal"), think("low"), think("medium"), think(null)]).toEqual([
      "low",
      "low",
      "medium",
      "medium",
    ]);
    expect([think("high"), think("xhigh"), think("max")]).toEqual(["high", "high", "high"]);
    expect(think("none")).toBe(false);
  });

  it("keeps the output limit within what's left of the context window", () => {
    const model = makeModel("openai", { maxOutputTokens: 100_000 });
    const step = makeStep();
    const p = { answerBudget: 2000, reasoningAllowance: 64_000 };
    expect(outputLimit(model, step, p)).toBe(66_000);
    expect(outputLimit(model, step, { ...p, contextRoom: 30_000 })).toBe(30_000);
    expect(outputLimit(model, step, { ...p, reasoningAllowance: Infinity })).toBe(100_000);
  });

  it("builds an Anthropic Messages body with cache breakpoints, schema and effort", () => {
    const body = buildRequestBody(
      makeConnection("https://api.anthropic.com", { kind: "anthropic" }),
      makeModel("anthropic"),
      makeStep({ reasoning: { enabled: true, effort: "high", budgetTokens: null } }),
      plan({ reasoningAllowance: 2000 }),
      true,
    );
    expect(body).toMatchObject({
      model: "fake-model",
      max_tokens: 3000,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema } },
    });
    expect(body.temperature).toBeUndefined();
    expect(body.system).toEqual([
      { type: "text", text: "You translate.\n\n" },
      { type: "text", text: expect.stringContaining("Respond with a single JSON object") },
    ]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "KB\n\n", cache_control: { type: "ephemeral" } },
          { type: "text", text: "Hello\n\n" },
        ],
      },
    ]);
  });

  it("leaves thinking to the model's default when reasoning is off, and keeps at most 4 breakpoints", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({
      role: "user" as const,
      label: `b${i}`,
      text: `block ${i}`,
      cacheBreakpoint: true,
    }));
    const p = plan({ blocks });
    const body = buildRequestBody(
      makeConnection("https://api.anthropic.com", { kind: "anthropic" }),
      makeModel("anthropic", { cacheMarkerTtl: "1h" }),
      makeStep(),
      p,
      false,
    );
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema } });
    const parts = (body.messages as { content: { cache_control?: unknown }[] }[])[0]!.content;
    expect(parts.filter((x) => x.cache_control).length).toBe(4);
    expect(parts[5]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // The caller's blocks are not changed by trimming the breakpoints.
    expect(p.blocks.every((b) => b.cacheBreakpoint)).toBe(true);
  });
});

describe("room for thinking", () => {
  it("doubles the effort default for providers that don't report thinking", () => {
    const base = { enabled: true, effort: "medium", budgetTokens: null, mode: "optional" as const };
    expect(reasoningAllowance({ ...base, samples: [] })).toBe(16_000);
    expect(
      reasoningAllowance({ ...base, samples: [], factor: thinkingRoomFactor("ollama_cloud") }),
    ).toBe(32_000);
    expect(thinkingRoomFactor("anthropic")).toBe(1);
    expect(thinkingRoomFactor("openai")).toBe(1);
    // A budget you set is used as is.
    expect(reasoningAllowance({ ...base, budgetTokens: 5000, samples: [], factor: 2 })).toBe(5000);
  });
});
