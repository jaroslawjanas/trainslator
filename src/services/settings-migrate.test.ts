import { describe, expect, it } from "vitest";
import { KIND_PRESETS } from "../llm/presets.ts";
import { defaultSettings, type Settings } from "../shared/schemas/settings.ts";
import { makeConnection, makeModel } from "../testing/llm-fixtures.ts";
import { migrateSettings } from "./settings-migrate.ts";

const oldOllama = {
  onEnabled: { reasoning_effort: "{{effort}}" },
  onDisabled: { reasoning_effort: "none" },
};

function settings(partial: Partial<Settings>): Settings {
  return { ...defaultSettings(), ...partial };
}

describe("settings migration", () => {
  it("moves OpenAI-style Ollama and Anthropic connections to the native APIs", () => {
    const s = settings({
      connections: [
        makeConnection("https://ollama.com/v1", { id: "c1", kind: "ollama" }),
        makeConnection("http://localhost:11434/v1", { id: "c2", kind: "ollama" }),
        makeConnection("https://api.anthropic.com/v1", { id: "c3", kind: "anthropic" }),
      ],
      models: [
        makeModel("custom", { id: "m1", connectionId: "c1", reasoningTemplates: oldOllama }),
        makeModel("custom", {
          id: "m2",
          connectionId: "c2",
          reasoningTemplates: { onEnabled: { think: "high" }, onDisabled: null },
        }),
        makeModel("custom", {
          id: "m3",
          connectionId: "c3",
          structuredOutput: "none",
          reasoningTemplates: {
            onEnabled: { thinking: { type: "enabled", budget_tokens: "{{budget}}" } },
            onDisabled: null,
          },
        }),
      ],
    });
    const next = migrateSettings(s)!;
    expect(next.connections.map((c) => [c.kind, c.baseUrl])).toEqual([
      ["ollama_cloud", "https://ollama.com"],
      ["ollama", "http://localhost:11434"],
      ["anthropic", "https://api.anthropic.com"],
    ]);
    // Old defaults are replaced; settings changed by hand are kept.
    expect(next.models[0]!.reasoningTemplates).toEqual(
      KIND_PRESETS.ollama_cloud.model.reasoningTemplates,
    );
    expect(next.models[1]!.reasoningTemplates).toEqual({
      onEnabled: { think: "high" },
      onDisabled: null,
    });
    expect(next.models[2]).toMatchObject(KIND_PRESETS.anthropic.model);
    // The stored key is untouched.
    expect(next.connections[0]!.apiKey).toEqual(s.connections[0]!.apiKey);
  });

  it("changes nothing in settings that are already current", () => {
    const s = settings({
      connections: [makeConnection("https://ollama.com", { kind: "ollama_cloud" })],
      models: [makeModel("ollama_cloud")],
    });
    expect(migrateSettings(s)).toBeNull();
    expect(migrateSettings(defaultSettings())).toBeNull();
  });
});
