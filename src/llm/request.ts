import type { Connection, Model, StepSettings } from "../shared/schemas/settings.ts";
import { describeSchema, type JsonSchema } from "./structured.ts";

/**
 * Prompts are built from ordered blocks, from most to least stable, so that
 * providers can reuse cached prefixes. Static blocks must render byte-identically
 * every time (no timestamps, stable ordering).
 */
export interface PromptBlock {
  role: "system" | "user";
  /** Short name for logs and token breakdowns. */
  label: string;
  text: string;
  /** Mark the end of a stable prefix (used for explicit cache markers). */
  cacheBreakpoint?: boolean;
}

/** Ends every block so tokenization at the join stays the same between calls. */
export const BLOCK_SEPARATOR = "\n\n";

export interface RequestPlan {
  blocks: PromptBlock[];
  schemaName: string;
  jsonSchema: JsonSchema;
  /** Expected size of the answer in tokens (without reasoning). */
  answerBudget: number;
  /** Tokens reserved for reasoning. */
  reasoningAllowance: number;
  /** Extra messages for repair turns: the model's last answer and what was wrong. */
  repair: { previous: string; problems: string }[];
  promptCacheKey: string | null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function substitute(value: unknown, effort: string | null, budget: number | null): unknown {
  if (typeof value === "string") {
    if (value === "{{budget}}") return budget ?? 4096;
    if (value === "{{effort}}") return effort ?? "medium";
    return value
      .replaceAll("{{effort}}", effort ?? "medium")
      .replaceAll("{{budget}}", String(budget ?? 4096));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, effort, budget));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, effort, budget)]),
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge: objects merge recursively, everything else is replaced. */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** Reasoning parameters for this request, from the model's templates. */
export function reasoningParams(model: Model, step: StepSettings): Record<string, unknown> | null {
  const { enabled, effort, budgetTokens } = step.reasoning;
  let template: Record<string, unknown> | null;
  if (enabled) template = model.reasoningTemplates.onEnabled;
  else if (model.reasoningMode === "mandatory") template = null;
  else template = model.reasoningTemplates.onDisabled;
  if (!template) return null;
  return substitute(template, effort, budgetTokens) as Record<string, unknown>;
}

/** The output token limit: answer + reasoning, capped by the model and the step. */
export function outputLimit(
  model: Model,
  step: StepSettings,
  plan: Pick<RequestPlan, "answerBudget" | "reasoningAllowance">,
): number {
  const cap = Math.min(model.maxOutputTokens, step.maxOutputTokens ?? Number.POSITIVE_INFINITY);
  const wanted = plan.answerBudget + plan.reasoningAllowance;
  return Math.max(256, Math.min(cap, wanted));
}

function schemaInstructions(plan: RequestPlan): string {
  return `Respond with a single JSON object and nothing else. It must match this structure exactly (use null where a value is unknown or doesn't apply; keys whose value is null may be left out):\n${describeSchema(plan.jsonSchema)}`;
}

function contentFor(blocks: PromptBlock[], markers: boolean, ttl: "5m" | "1h"): string | Json[] {
  if (!markers) return blocks.map((b) => b.text + BLOCK_SEPARATOR).join("");
  return blocks.map((b) => {
    const part: { [key: string]: Json } = { type: "text", text: b.text + BLOCK_SEPARATOR };
    if (b.cacheBreakpoint)
      part.cache_control = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    return part;
  });
}

/** Builds the Chat Completions request body. */
export function buildRequestBody(
  connection: Connection,
  model: Model,
  step: StepSettings,
  plan: RequestPlan,
  stream: boolean,
): Record<string, unknown> {
  const markers = model.cacheMarkers === "anthropic";
  const systemBlocks = plan.blocks.filter((b) => b.role === "system");
  const userBlocks = plan.blocks.filter((b) => b.role === "user");
  // Always describe the structure in the prompt too: many providers accept
  // response_format but don't enforce it.
  systemBlocks.push({ role: "system", label: "output format", text: schemaInstructions(plan) });
  // At most 4 explicit cache breakpoints (Anthropic's limit); keep the last ones.
  if (markers) {
    const flagged = [...systemBlocks, ...userBlocks].filter((b) => b.cacheBreakpoint);
    for (const b of flagged.slice(0, Math.max(0, flagged.length - 4))) b.cacheBreakpoint = false;
  }

  const messages: Json[] = [];
  if (systemBlocks.length > 0) {
    messages.push({
      role: "system",
      content: contentFor(systemBlocks, markers, model.cacheMarkerTtl),
    });
  }
  messages.push({ role: "user", content: contentFor(userBlocks, markers, model.cacheMarkerTtl) });
  for (const turn of plan.repair) {
    messages.push({ role: "assistant", content: turn.previous });
    messages.push({ role: "user", content: turn.problems });
  }

  let body: Record<string, unknown> = {
    model: model.modelName,
    messages,
    [model.maxTokensParam]: outputLimit(model, step, plan),
  };
  if (model.structuredOutput === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: plan.schemaName, strict: true, schema: plan.jsonSchema },
    };
  } else if (model.structuredOutput === "json_object") {
    body.response_format = { type: "json_object" };
  }
  if (step.temperature !== null && model.sendTemperature) body.temperature = step.temperature;
  if (model.sendPromptCacheKey && plan.promptCacheKey) body.prompt_cache_key = plan.promptCacheKey;
  if (connection.kind === "openrouter" && model.structuredOutput === "json_schema") {
    body.provider = { require_parameters: true };
  }
  const reasoning = reasoningParams(model, step);
  if (reasoning) body = deepMerge(body, reasoning);
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (step.extraBody) body = deepMerge(body, step.extraBody);
  return body;
}
