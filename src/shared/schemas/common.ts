import { z } from "zod";

/** Ids used in URLs and file paths: letters, digits, `_` and `-` only. */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const Id = z.string().regex(ID_RE, "Invalid id");
export type Id = z.infer<typeof Id>;

export const IsoDate = z.string();

export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

export const SCHEMA_VERSION = 1 as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** Random id with a readable prefix, e.g. `pr_3f9a0c2b7d1e4a56`. */
export function newId(prefix: string): string {
  const raw = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `${prefix}_${raw}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const Usage = z.object({
  calls: z.number().int().nonnegative(),
  promptTokens: z.number().nonnegative(),
  cachedTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  completionTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative(),
  cost: z.number().nonnegative().nullable(),
  /** True when at least one call had no usage report and tokens were estimated. */
  estimated: z.boolean(),
});
export type Usage = z.infer<typeof Usage>;

export function emptyUsage(): Usage {
  return {
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cost: null,
    estimated: false,
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0),
    estimated: a.estimated || b.estimated,
  };
}

export const Diagnostic = z.object({
  level: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  docIndex: z.number().int().nullable().default(null),
  count: z.number().int().positive().default(1),
});
export type Diagnostic = z.infer<typeof Diagnostic>;
