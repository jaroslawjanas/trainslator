import { z } from "zod";
import { STEPS, type Step } from "../steps.ts";
import { Id, JsonObject, SchemaVersion } from "./common.ts";

export const ConnectionKind = z.enum([
  "openai",
  "openrouter",
  "deepseek",
  "gemini",
  "anthropic",
  "vllm",
  "ollama",
  "custom",
]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export const ApiKeyRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("env"), name: z.string().min(1) }),
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type ApiKeyRef = z.infer<typeof ApiKeyRef>;

export const HeaderSetting = z.object({
  name: z.string().min(1),
  value: z.string(),
  secret: z.boolean().default(false),
});
export type HeaderSetting = z.infer<typeof HeaderSetting>;

export const Connection = z.object({
  id: Id,
  name: z.string().min(1),
  kind: ConnectionKind,
  baseUrl: z.url(),
  apiKey: ApiKeyRef,
  headers: z.array(HeaderSetting).default([]),
  /** Cap on parallel requests across all models of this connection. */
  maxParallel: z.number().int().positive().nullable().default(null),
  /** Total deadline for one request, in seconds. */
  timeoutSec: z.number().int().positive().default(1800),
  /** Abort a streamed request when no data arrives for this long, in seconds. */
  idleTimeoutSec: z.number().int().positive().default(600),
  maxRetries: z.number().int().min(0).max(10).default(4),
  stream: z.boolean().default(true),
});
export type Connection = z.infer<typeof Connection>;

export const ReasoningTemplates = z.object({
  /** Merged into the request body when reasoning is enabled. `{{effort}}` and `{{budget}}` are replaced. */
  onEnabled: JsonObject.nullable(),
  /** Merged into the request body when reasoning is disabled. */
  onDisabled: JsonObject.nullable(),
});
export type ReasoningTemplates = z.infer<typeof ReasoningTemplates>;

export const Pricing = z.object({
  inputPerM: z.number().nonnegative(),
  cachedInputPerM: z.number().nonnegative(),
  cacheWritePerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
});
export type Pricing = z.infer<typeof Pricing>;

export const Model = z.object({
  id: Id,
  connectionId: Id,
  modelName: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxParallel: z.number().int().positive().default(4),
  structuredOutput: z.enum(["json_schema", "json_object", "none"]),
  maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]),
  sendTemperature: z.boolean(),
  reasoningMode: z.enum(["optional", "on_by_default", "mandatory"]),
  reasoningTemplates: ReasoningTemplates,
  cacheMarkers: z.enum(["none", "anthropic"]),
  cacheMarkerTtl: z.enum(["5m", "1h"]).default("5m"),
  sendPromptCacheKey: z.boolean(),
  pricing: Pricing.nullable().default(null),
});
export type Model = z.infer<typeof Model>;

export const ReasoningSettings = z.object({
  enabled: z.boolean(),
  /** Free text: none, minimal, low, medium, high, xhigh, max, or whatever the provider accepts. */
  effort: z.string().nullable(),
  budgetTokens: z.number().int().positive().nullable(),
});
export type ReasoningSettings = z.infer<typeof ReasoningSettings>;

export const StepSettings = z.object({
  modelId: Id.nullable(),
  reasoning: ReasoningSettings,
  temperature: z.number().min(0).max(2).nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  extraBody: JsonObject.nullable(),
});
export type StepSettings = z.infer<typeof StepSettings>;

export const StepSettingsMap = z.object(
  Object.fromEntries(STEPS.map((s) => [s, StepSettings])) as Record<Step, typeof StepSettings>,
);
export type StepSettingsMap = Record<Step, StepSettings>;

export const Settings = z.object({
  schemaVersion: SchemaVersion,
  connections: z.array(Connection),
  models: z.array(Model),
  steps: StepSettingsMap,
});
export type Settings = z.infer<typeof Settings>;

export function defaultStepSettings(): StepSettings {
  return {
    modelId: null,
    reasoning: { enabled: false, effort: null, budgetTokens: null },
    temperature: null,
    maxOutputTokens: null,
    extraBody: null,
  };
}

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    connections: [],
    models: [],
    steps: Object.fromEntries(STEPS.map((s) => [s, defaultStepSettings()])) as StepSettingsMap,
  };
}

/** Value shown instead of a stored secret in API responses. */
export const MASKED = "••••••••";

/** Learned per-model numbers, kept separate from user settings. */
export const ModelCalibration = z.object({
  /** Multiplier applied to character-based token estimates. */
  tokenFactor: z.number().positive(),
  tokenSamples: z.number().int().nonnegative(),
  /** Recent reasoning-token counts per step (newest last). */
  reasoningSamples: z.record(z.string(), z.array(z.number().nonnegative())),
});
export type ModelCalibration = z.infer<typeof ModelCalibration>;

export const Calibration = z.object({
  schemaVersion: SchemaVersion,
  models: z.record(z.string(), ModelCalibration),
});
export type Calibration = z.infer<typeof Calibration>;
