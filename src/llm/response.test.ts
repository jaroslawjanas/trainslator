import { describe, expect, it } from "vitest";
import { findJsonObjects, jsonCandidates, normalizeUsage, stripReasoning } from "./response.ts";

describe("reasoning leaks", () => {
  it("removes complete reasoning blocks", () => {
    expect(stripReasoning('<think>let me see {"a": 1}</think>\n{"b": 2}').trim()).toBe('{"b": 2}');
    expect(stripReasoning("<Thinking>x</Thinking>ok").trim()).toBe("ok");
  });

  it("drops everything before a closing tag that has no opening tag", () => {
    expect(stripReasoning('reasoning here… {"draft": true}</think>\n{"final": true}').trim()).toBe(
      '{"final": true}',
    );
  });

  it("keeps only the final channel of gpt-oss style output", () => {
    const raw =
      '<|channel|>analysis<|message|>thinking {"x":1}<|end|><|start|>assistant<|channel|>final<|message|>{"y":2}<|return|>';
    expect(stripReasoning(raw)).toBe('{"y":2}');
  });
});

describe("JSON extraction", () => {
  it("finds objects while respecting braces inside strings", () => {
    expect(findJsonObjects('pre {"a": "}{"} mid {"b": {"c": 1}} end')).toEqual([
      '{"a": "}{"}',
      '{"b": {"c": 1}}',
    ]);
  });

  it("prefers the whole reply, then the largest object", () => {
    expect(jsonCandidates('{"ok": 1}')).toEqual([{ ok: 1 }]);
    const candidates = jsonCandidates(
      'Here is an example: {"id": 1}. Final answer:\n```json\n{"items": [{"id": 1}, {"id": 2}]}\n```',
    );
    expect(candidates[0]).toEqual({ items: [{ id: 1 }, { id: 2 }] });
  });
});

describe("usage", () => {
  it("normalizes OpenAI, DeepSeek and OpenRouter usage", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 20 },
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      reasoningTokens: 20,
      cachedTokens: 80,
      cacheWriteTokens: 0,
      cost: null,
    });
    expect(
      normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 7 })
        ?.cachedTokens,
    ).toBe(7);
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 })?.cost).toBe(
      0.0012,
    );
    expect(normalizeUsage(null)).toBeNull();
  });
});
