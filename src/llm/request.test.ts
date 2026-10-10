import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeConnection, makeModel, makeStep } from "../testing/llm-fixtures.ts";
import { buildRequestBody, type RequestPlan } from "./request.ts";
import { toStrictJsonSchema } from "./structured.ts";

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
    repair: [],
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
    const anthropic = makeModel("anthropic");
    const on = buildRequestBody(
      makeConnection("http://x"),
      anthropic,
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
      plan({ repair: [{ previous: "{}", problems: "missing answer" }] }),
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
