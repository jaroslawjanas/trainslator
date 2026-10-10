import { KIND_PRESETS } from "../llm/presets.ts";
import type { Connection, Model, Settings } from "../shared/schemas/settings.ts";

/**
 * Ollama and Anthropic connections used to go through those providers'
 * OpenAI-compatible endpoints (base URLs ending in /v1). They now use the
 * native APIs, so old connections are moved over: the base URL loses /v1,
 * an ollama.com connection becomes "Ollama Cloud", and model settings that
 * still have the old defaults get the new ones (for Ollama, the reasoning
 * effort is now sent as the thinking level). Anything you changed by hand
 * is kept.
 */

const OLD_OLLAMA_TEMPLATES = {
  onEnabled: { reasoning_effort: "{{effort}}" },
  onDisabled: { reasoning_effort: "none" },
};
/** The native Ollama default before the effort was sent as a thinking level. */
const PLAIN_THINK_TEMPLATES = {
  onEnabled: { think: true },
  onDisabled: { think: false },
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
    (same(m.reasoningTemplates, OLD_OLLAMA_TEMPLATES) ||
      same(m.reasoningTemplates, PLAIN_THINK_TEMPLATES))
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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parallel limits used to be set per model, with an optional cap per
 * connection. Now only connections have one: a connection without a cap
 * takes the highest of its models' limits (4 when none had one). Runs on
 * the file as read, before it's checked against the current schema.
 */
export function migrateRawSettings(raw: unknown): unknown {
  if (!isObject(raw) || !Array.isArray(raw.connections)) return raw;
  const models = Array.isArray(raw.models) ? raw.models.filter(isObject) : [];
  const connections = raw.connections.map((c: unknown) => {
    if (!isObject(c) || typeof c.maxParallel === "number") return c;
    const limits = models
      .filter((m) => m.connectionId === c.id && typeof m.maxParallel === "number")
      .map((m) => m.maxParallel as number);
    return { ...c, maxParallel: limits.length > 0 ? Math.max(...limits) : 4 };
  });
  return {
    ...raw,
    connections,
    models: Array.isArray(raw.models)
      ? raw.models.map((m: unknown) => {
          if (!isObject(m) || !("maxParallel" in m)) return m;
          const { maxParallel: _, ...rest } = m;
          return rest;
        })
      : raw.models,
  };
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
