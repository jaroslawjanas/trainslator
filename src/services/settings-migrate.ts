import { KIND_PRESETS } from "../llm/presets.ts";
import type { Connection, Model, Settings } from "../shared/schemas/settings.ts";

/**
 * Ollama and Anthropic connections used to go through those providers'
 * OpenAI-compatible endpoints (base URLs ending in /v1). They now use the
 * native APIs, so old connections are moved over: the base URL loses /v1,
 * an ollama.com connection becomes "Ollama Cloud", and model settings that
 * still have the old defaults get the new ones. Anything you changed by hand
 * is kept.
 */

const OLD_OLLAMA_TEMPLATES = {
  onEnabled: { reasoning_effort: "{{effort}}" },
  onDisabled: { reasoning_effort: "none" },
};
const OLD_ANTHROPIC_TEMPLATES = {
  onEnabled: { thinking: { type: "enabled", budget_tokens: "{{budget}}" } },
  onDisabled: null,
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function migrateConnection(c: Connection): Connection {
  if (c.kind === "ollama" && /\/v1\/?$/.test(c.baseUrl)) {
    if (/^https?:\/\/(www\.)?ollama\.com/i.test(c.baseUrl))
      return { ...c, kind: "ollama_cloud", baseUrl: "https://ollama.com" };
    return { ...c, baseUrl: c.baseUrl.replace(/\/v1\/?$/, "") };
  }
  if (c.kind === "anthropic" && /\/v1\/?$/.test(c.baseUrl))
    return { ...c, baseUrl: c.baseUrl.replace(/\/v1\/?$/, "") };
  return c;
}

function migrateModel(m: Model, connection: Connection | undefined): Model {
  if (!connection) return m;
  if (
    (connection.kind === "ollama" || connection.kind === "ollama_cloud") &&
    same(m.reasoningTemplates, OLD_OLLAMA_TEMPLATES)
  ) {
    return { ...m, reasoningTemplates: KIND_PRESETS[connection.kind].model.reasoningTemplates };
  }
  if (
    connection.kind === "anthropic" &&
    m.structuredOutput === "none" &&
    same(m.reasoningTemplates, OLD_ANTHROPIC_TEMPLATES)
  ) {
    return { ...m, ...KIND_PRESETS.anthropic.model };
  }
  return m;
}

/** The migrated settings, or null when nothing needed to change. */
export function migrateSettings(settings: Settings): Settings | null {
  const connections = settings.connections.map(migrateConnection);
  const models = settings.models.map((m) =>
    migrateModel(
      m,
      connections.find((c) => c.id === m.connectionId),
    ),
  );
  const next = { ...settings, connections, models };
  return same(next, settings) ? null : next;
}
