import {
  type Connection,
  type ConnectionKind,
  type Model,
  protocolOf,
  type StepSettings,
} from "../shared/schemas/settings.ts";
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

/** A function the model may call, e.g. to ask the advisor. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  /** The call's id, as the model gave it. */
  id: string;
  name: string;
  content: string;
}

/** A follow-up after the first answer: a repair turn, or tool calls and their results. */
export type Turn =
  | { kind: "repair"; previous: string; problems: string }
  | {
      kind: "tools";
      /** The model's message with the calls, in its API's own shape, sent back as it came. */
      assistant: unknown;
      results: ToolResult[];
    };

export interface RequestPlan {
  blocks: PromptBlock[];
  schemaName: string;
  /** Structure the answer must have; null for a plain-text answer. */
  jsonSchema: JsonSchema | null;
  /** Expected size of the answer in tokens (without reasoning). */
  answerBudget: number;
  /** Tokens reserved for reasoning. */
  reasoningAllowance: number;
  /** Tokens left in the context window after the prompt; the output limit stays under it. */
  contextRoom?: number;
  /** Messages after the first: repair turns and tool calls, in order. */
  turns: Turn[];
  /** Functions the model may call. */
  tools?: ToolSpec[];
  promptCacheKey: string | null;
}

/**
 * Servers that force the whole output into the schema, so a model can't
 * call a tool while it's enforced. With tools offered, the schema is only
 * described in the prompt (and the answer checked as always).
 */
const SCHEMA_BLOCKS_TOOLS = new Set<ConnectionKind>(["ollama", "ollama_cloud", "vllm"]);

function enforceSchema(connection: Connection, plan: RequestPlan): boolean {
  return (
    plan.jsonSchema !== null && !(plan.tools?.length && SCHEMA_BLOCKS_TOOLS.has(connection.kind))
  );
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

/**
 * The output token limit: answer + reasoning, capped by the model, the step
 * and what's left of the context window. It's a ceiling, not a target: the
 * reasoning effort sent to the model decides how much it thinks.
 */
export function outputLimit(
  model: Model,
  step: StepSettings,
  plan: Pick<RequestPlan, "answerBudget" | "reasoningAllowance" | "contextRoom">,
): number {
  const cap = Math.min(
    model.maxOutputTokens,
    step.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    plan.contextRoom ?? Number.POSITIVE_INFINITY,
  );
  const wanted = plan.answerBudget + plan.reasoningAllowance;
  return Math.max(256, Math.min(cap, wanted));
}

function schemaInstructions(schema: JsonSchema): string {
  return `Respond with a single JSON object and nothing else. It must match this structure exactly (use null where a value is unknown or doesn't apply; keys whose value is null may be left out):\n${describeSchema(schema)}`;
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

function cacheControl(ttl: "5m" | "1h"): { [key: string]: Json } {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * The plan's blocks plus the output-format instructions, split by role.
 * Copies, so cache-marker trimming never changes the caller's blocks.
 */
function promptParts(plan: RequestPlan, markers: boolean) {
  const systemBlocks = plan.blocks.filter((b) => b.role === "system").map((b) => ({ ...b }));
  const userBlocks = plan.blocks.filter((b) => b.role === "user").map((b) => ({ ...b }));
  // Always describe the structure in the prompt too: many providers accept
  // a schema but don't enforce it.
  if (plan.jsonSchema)
    systemBlocks.push({
      role: "system",
      label: "output format",
      text: schemaInstructions(plan.jsonSchema),
    });
  if (markers) {
    // At most 4 explicit cache breakpoints (Anthropic's limit); keep the last ones.
    const flagged = [...systemBlocks, ...userBlocks].filter((b) => b.cacheBreakpoint);
    for (const b of flagged.slice(0, Math.max(0, flagged.length - 4))) b.cacheBreakpoint = false;
  } else {
    for (const b of [...systemBlocks, ...userBlocks]) b.cacheBreakpoint = false;
  }
  return { systemBlocks, userBlocks };
}

function joined(blocks: PromptBlock[]): string {
  return blocks.map((b) => b.text + BLOCK_SEPARATOR).join("");
}

/** Tools in the OpenAI function format (also Ollama's). */
function functionTools(tools: ToolSpec[]): Json[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as { [key: string]: Json },
    },
  }));
}

/** Builds the request body in the format of the connection's API. */
export function buildRequestBody(
  connection: Connection,
  model: Model,
  step: StepSettings,
  plan: RequestPlan,
  stream: boolean,
): Record<string, unknown> {
  const protocol = protocolOf(connection.kind);
  if (protocol === "ollama") return buildOllamaBody(connection, model, step, plan, stream);
  if (protocol === "anthropic") return buildAnthropicBody(model, step, plan, stream);
  if (protocol === "claude_code") return buildClaudeCodeBody(model, step, plan, stream);
  return buildChatCompletionsBody(connection, model, step, plan, stream);
}

/** The output limit as it appears in a request body of any protocol (for logs). */
export function bodyOutputLimit(body: Record<string, unknown>): number | null {
  const options = body.options as Record<string, unknown> | undefined;
  const value = body.max_tokens ?? body.max_completion_tokens ?? options?.num_predict;
  return typeof value === "number" ? value : null;
}

/** OpenAI-compatible Chat Completions. */
function buildChatCompletionsBody(
  connection: Connection,
  model: Model,
  step: StepSettings,
  plan: RequestPlan,
  stream: boolean,
): Record<string, unknown> {
  const markers = model.cacheMarkers === "anthropic";
  const { systemBlocks, userBlocks } = promptParts(plan, markers);

  const messages: Json[] = [];
  if (systemBlocks.length > 0) {
    messages.push({
      role: "system",
      content: contentFor(systemBlocks, markers, model.cacheMarkerTtl),
    });
  }
  messages.push({ role: "user", content: contentFor(userBlocks, markers, model.cacheMarkerTtl) });
  for (const turn of plan.turns) {
    if (turn.kind === "repair") {
      messages.push({ role: "assistant", content: turn.previous });
      messages.push({ role: "user", content: turn.problems });
    } else {
      messages.push(turn.assistant as Json);
      for (const r of turn.results)
        messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }

  let body: Record<string, unknown> = {
    model: model.modelName,
    messages,
    [model.maxTokensParam]: outputLimit(model, step, plan),
  };
  if (plan.jsonSchema && enforceSchema(connection, plan)) {
    if (model.structuredOutput === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: plan.schemaName, strict: true, schema: plan.jsonSchema },
      };
    } else if (model.structuredOutput === "json_object") {
      body.response_format = { type: "json_object" };
    }
  }
  if (plan.tools?.length) body.tools = functionTools(plan.tools);
  if (step.temperature !== null && model.sendTemperature) body.temperature = step.temperature;
  if (model.sendPromptCacheKey && plan.promptCacheKey) body.prompt_cache_key = plan.promptCacheKey;
  // Only providers that honour the schema and the tools.
  if (
    connection.kind === "openrouter" &&
    ((body.response_format && model.structuredOutput === "json_schema") || body.tools)
  ) {
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

/**
 * Ollama's "think" is on/off, or a level ("low", "medium", "high") for
 * models that have levels. Other efforts go to the nearest level.
 */
function ollamaThink(value: unknown): unknown {
  if (typeof value !== "string") return value;
  switch (value.trim().toLowerCase()) {
    case "none":
    case "false":
      return false;
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return true;
  }
}

/**
 * Ollama's own chat API (/api/chat), on this computer or on Ollama Cloud.
 * Unlike its OpenAI-compatible endpoint it honours the output limit
 * (num_predict), can set the context size (num_ctx) and enforces the schema.
 */
function buildOllamaBody(
  connection: Connection,
  model: Model,
  step: StepSettings,
  plan: RequestPlan,
  stream: boolean,
): Record<string, unknown> {
  const { systemBlocks, userBlocks } = promptParts(plan, false);
  const messages: Json[] = [
    { role: "system", content: joined(systemBlocks) },
    { role: "user", content: joined(userBlocks) },
  ];
  for (const turn of plan.turns) {
    if (turn.kind === "repair") {
      messages.push({ role: "assistant", content: turn.previous });
      messages.push({ role: "user", content: turn.problems });
    } else {
      messages.push(turn.assistant as Json);
      for (const r of turn.results)
        messages.push({ role: "tool", content: r.content, tool_name: r.name });
    }
  }
  const options: Record<string, unknown> = { num_predict: outputLimit(model, step, plan) };
  // On this computer the context size must be asked for, or Ollama's small
  // default silently cuts long prompts. Ollama Cloud manages it itself.
  if (connection.kind === "ollama") options.num_ctx = model.contextWindow;
  if (step.temperature !== null && model.sendTemperature) options.temperature = step.temperature;
  // The ":cloud" / "-cloud" suffix is for the Ollama app; the cloud API wants the plain name.
  const name =
    connection.kind === "ollama_cloud"
      ? model.modelName.replace(/[-:]cloud$/, "")
      : model.modelName;
  let body: Record<string, unknown> = { model: name, messages, stream, options };
  if (plan.jsonSchema && enforceSchema(connection, plan)) {
    if (model.structuredOutput === "json_schema") body.format = plan.jsonSchema;
    else if (model.structuredOutput === "json_object") body.format = "json";
  }
  if (plan.tools?.length) body.tools = functionTools(plan.tools);
  const reasoning = reasoningParams(model, step);
  if (reasoning)
    body = deepMerge(
      body,
      "think" in reasoning ? { ...reasoning, think: ollamaThink(reasoning.think) } : reasoning,
    );
  if (step.extraBody) body = deepMerge(body, step.extraBody);
  return body;
}

/**
 * Claude Code (`claude -p`): not an HTTP body, but what the run needs. The
 * stable part (instructions, and the user blocks up to the last cache
 * breakpoint, e.g. the knowledge bases) becomes the system prompt, which
 * Claude Code caches; the rest is the prompt. Follow-up turns are written
 * into the prompt, since each run is a fresh conversation. It takes no
 * output limit, temperature or tools.
 */
function buildClaudeCodeBody(
  model: Model,
  step: StepSettings,
  plan: RequestPlan,
  stream: boolean,
): Record<string, unknown> {
  const { systemBlocks } = promptParts(plan, false);
  const userBlocks = plan.blocks.filter((b) => b.role === "user");
  let stable = userBlocks.findLastIndex((b) => b.cacheBreakpoint) + 1;
  // Something must go through stdin.
  if (stable >= userBlocks.length) stable = userBlocks.length - 1;
  const turns = plan.turns.flatMap((t) =>
    t.kind === "repair"
      ? [`# Your previous answer\n${t.previous}\n\n# What was wrong with it\n${t.problems}`]
      : [],
  );
  let body: Record<string, unknown> = {
    model: model.modelName,
    system: joined([...systemBlocks, ...userBlocks.slice(0, Math.max(0, stable))]),
    prompt: [joined(userBlocks.slice(Math.max(0, stable))), ...turns].join("\n\n"),
    stream,
  };
  if (plan.jsonSchema && model.structuredOutput === "json_schema")
    body.json_schema = plan.jsonSchema;
  const reasoning = reasoningParams(model, step);
  if (reasoning) body = deepMerge(body, reasoning);
  if (step.extraBody) body = deepMerge(body, step.extraBody);
  return body;
}

/** Anthropic's Messages API: system and user blocks keep their cache breakpoints. */
function buildAnthropicBody(
  model: Model,
  step: StepSettings,
  plan: RequestPlan,
  stream: boolean,
): Record<string, unknown> {
  const markers = model.cacheMarkers === "anthropic";
  const { systemBlocks, userBlocks } = promptParts(plan, markers);
  const textBlock = (b: PromptBlock): { [key: string]: Json } => {
    const block: { [key: string]: Json } = { type: "text", text: b.text + BLOCK_SEPARATOR };
    if (b.cacheBreakpoint) block.cache_control = cacheControl(model.cacheMarkerTtl);
    return block;
  };
  const messages: Json[] = [{ role: "user", content: userBlocks.map(textBlock) }];
  for (const turn of plan.turns) {
    if (turn.kind === "repair") {
      messages.push({ role: "assistant", content: turn.previous });
      messages.push({ role: "user", content: turn.problems });
    } else {
      messages.push(turn.assistant as Json);
      messages.push({
        role: "user",
        content: turn.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
        })),
      });
    }
  }
  let body: Record<string, unknown> = {
    model: model.modelName,
    max_tokens: outputLimit(model, step, plan),
    system: systemBlocks.map(textBlock),
    messages,
  };
  if (plan.jsonSchema && model.structuredOutput === "json_schema") {
    body.output_config = { format: { type: "json_schema", schema: plan.jsonSchema } };
  }
  if (plan.tools?.length)
    body.tools = plan.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as { [key: string]: Json },
    }));
  if (step.temperature !== null && model.sendTemperature) body.temperature = step.temperature;
  const reasoning = reasoningParams(model, step);
  if (reasoning) body = deepMerge(body, reasoning);
  if (stream) body.stream = true;
  if (step.extraBody) body = deepMerge(body, step.extraBody);
  return body;
}
