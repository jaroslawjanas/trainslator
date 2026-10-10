import { z } from "zod";
import {
  type Connection,
  defaultStepSettings,
  type Model,
  type Pricing,
  protocolOf,
} from "../shared/schemas/settings.ts";
import { listAnthropicModels } from "./anthropic.ts";
import { classifyError, type LlmRuntime, send } from "./call.ts";
import { LlmError } from "./errors.ts";
import { listOllamaModels } from "./ollama.ts";
import { buildRequestBody, type RequestPlan } from "./request.ts";
import { jsonCandidates } from "./response.ts";
import { toStrictJsonSchema } from "./structured.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * "Test connection": checks that a model answers, which JSON mode works,
 * which parameters it accepts, whether reasoning can be switched, and
 * (optionally) whether long prompts and caching work. It suggests settings
 * rather than changing them.
 */

export interface ProbeCheck {
  name: string;
  ok: boolean | null;
  detail: string;
}

export interface ProbeReport {
  checks: ProbeCheck[];
  suggestions: Partial<Model>;
  latencyMs: number | null;
  requests: number;
}

export interface ListedModel {
  id: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: Pricing | null;
}

/** The app's hardest output shape (like phase 2 edits), plus a decoy key that only a schema-following model includes. */
const ProbeSchema = z.object({
  zq_probe_ok: z.boolean(),
  edits: z.array(
    z.object({
      op: z.enum(["add", "update", "resolve", "remove"]),
      id: z.string().nullable(),
      fields: z
        .object({
          kind: z.enum(["person", "place", "term"]).nullable(),
          source: z.string().nullable(),
          target: z.string().nullable(),
          attributes: z.array(z.object({ key: z.string(), value: z.string() })).nullable(),
        })
        .nullable(),
      reason: z.string(),
    }),
  ),
});

function plan(text: string, answerBudget = 400): RequestPlan {
  return {
    blocks: [
      {
        role: "system",
        label: "instructions",
        text: "You are testing an API connection. Follow the requested JSON structure exactly.",
      },
      { role: "user", label: "task", text },
    ],
    schemaName: "probe",
    jsonSchema: toStrictJsonSchema(ProbeSchema),
    answerBudget,
    reasoningAllowance: 0,
    repair: [],
    promptCacheKey: null,
  };
}

const TASK =
  'Return JSON with "zq_probe_ok": true and one edit: op "add", id null, fields {kind "person", source "Mira", target "Mira", attributes [{"key": "gender", "value": "female"}]}, reason "test".';

function numberOr(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export async function listModels(rt: LlmRuntime, connection: Connection): Promise<ListedModel[]> {
  const protocol = protocolOf(connection.kind);
  if (protocol === "anthropic") {
    const models = await listAnthropicModels(rt.clients.anthropic(connection));
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }
  if (protocol === "ollama") {
    const names = await listOllamaModels(connection);
    return names
      .map((id) => ({ id, contextWindow: null, maxOutputTokens: null, pricing: null }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  const client = rt.clients.get(connection);
  const out: ListedModel[] = [];
  try {
    for await (const m of client.models.list()) {
      const raw = m as unknown as Record<string, unknown>;
      const pricing = raw.pricing as Record<string, unknown> | undefined;
      const top = raw.top_provider as Record<string, unknown> | undefined;
      const prompt = numberOr(pricing?.prompt);
      const completion = numberOr(pricing?.completion);
      out.push({
        id: String(raw.id),
        contextWindow:
          numberOr(raw.context_length) ??
          numberOr(raw.max_model_len) ??
          numberOr(raw.context_window),
        maxOutputTokens: numberOr(top?.max_completion_tokens),
        pricing:
          prompt !== null && completion !== null
            ? {
                inputPerM: prompt * 1_000_000,
                cachedInputPerM: (numberOr(pricing?.input_cache_read) ?? prompt) * 1_000_000,
                cacheWritePerM: (numberOr(pricing?.input_cache_write) ?? prompt) * 1_000_000,
                outputPerM: completion * 1_000_000,
              }
            : null,
      });
      if (out.length >= 2000) break;
    }
  } catch (error) {
    throw classifyError(error, null);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ProbeOptions {
  /** Also send a long prompt (checks for silent truncation) and repeat it (checks caching). Costs more tokens. */
  deep?: boolean;
  signal?: AbortSignal;
}

export async function testModel(
  rt: LlmRuntime,
  connection: Connection,
  model: Model,
  options: ProbeOptions = {},
): Promise<ProbeReport> {
  const checks: ProbeCheck[] = [];
  const suggestions: Partial<Model> = {};
  let current: Model = { ...model };
  let latencyMs: number | null = null;
  let requests = 0;
  const conn: Connection = {
    ...connection,
    stream: false,
    maxRetries: 1,
    timeoutSec: Math.min(connection.timeoutSec, 300),
  };
  const step = defaultStepSettings();

  async function attempt(
    m: Model,
    p: RequestPlan,
    reasoning?: { enabled: boolean; effort: string | null },
  ) {
    const s = {
      ...step,
      reasoning: {
        enabled: reasoning?.enabled ?? false,
        effort: reasoning?.effort ?? null,
        budgetTokens: reasoning?.enabled ? 1024 : null,
      },
    };
    const body = buildRequestBody(conn, m, s, p, false);
    requests++;
    const started = Date.now();
    const raw = await send(rt, conn, body, options.signal);
    return { raw, ms: Date.now() - started };
  }

  // 1. Basic answer with structured output; adjust parameters the provider rejects.
  let basic: Awaited<ReturnType<typeof attempt>> | null = null;
  for (let tries = 0; tries < 4 && !basic; tries++) {
    try {
      basic = await attempt(current, plan(TASK));
    } catch (error) {
      const err = error instanceof LlmError ? error : classifyError(error, null);
      const message = err.message.toLowerCase();
      if (
        err.kind === "bad_request" &&
        message.includes("max_completion_tokens") &&
        current.maxTokensParam === "max_completion_tokens"
      ) {
        current = { ...current, maxTokensParam: "max_tokens" };
        suggestions.maxTokensParam = "max_tokens";
        continue;
      }
      if (
        err.kind === "bad_request" &&
        message.includes("max_tokens") &&
        current.maxTokensParam === "max_tokens"
      ) {
        current = { ...current, maxTokensParam: "max_completion_tokens" };
        suggestions.maxTokensParam = "max_completion_tokens";
        continue;
      }
      if (
        err.kind === "bad_request" &&
        /response_format|json_schema|schema/.test(message) &&
        current.structuredOutput !== "none"
      ) {
        const next = current.structuredOutput === "json_schema" ? "json_object" : "none";
        current = { ...current, structuredOutput: next };
        suggestions.structuredOutput = next;
        continue;
      }
      if (
        err.kind === "bad_request" &&
        message.includes("does not support thinking") &&
        (current.reasoningTemplates.onEnabled || current.reasoningTemplates.onDisabled)
      ) {
        current = { ...current, reasoningTemplates: { onEnabled: null, onDisabled: null } };
        suggestions.reasoningTemplates = current.reasoningTemplates;
        continue;
      }
      if (err.kind === "bad_request" && message.includes("prompt_cache_key")) {
        current = { ...current, sendPromptCacheKey: false };
        suggestions.sendPromptCacheKey = false;
        continue;
      }
      checks.push({ name: "Answer", ok: false, detail: err.message });
      return { checks, suggestions, latencyMs, requests };
    }
  }
  if (!basic) {
    checks.push({
      name: "Answer",
      ok: false,
      detail: "The provider kept rejecting the request parameters.",
    });
    return { checks, suggestions, latencyMs, requests };
  }
  latencyMs = basic.ms;
  checks.push({
    name: "Answer",
    ok: true,
    detail: `Answered in ${(basic.ms / 1000).toFixed(1)} s.`,
  });

  const candidates = jsonCandidates(basic.raw.content);
  const parsed = candidates.map((c) => ProbeSchema.safeParse(c)).find((r) => r.success);
  const anyObject = candidates.find((c) => c && typeof c === "object") as
    | Record<string, unknown>
    | undefined;
  if (parsed?.success) {
    checks.push({
      name: "Structured output",
      ok: true,
      detail: `Valid JSON in "${current.structuredOutput}" mode.`,
    });
  } else if (anyObject && !("zq_probe_ok" in anyObject) && current.structuredOutput !== "none") {
    suggestions.structuredOutput = "none";
    checks.push({
      name: "Structured output",
      ok: false,
      detail:
        "The answer was JSON but ignored the requested structure, so response_format seems to be ignored. Use mode 'none' (the structure is then described in the prompt).",
    });
  } else {
    checks.push({
      name: "Structured output",
      ok: false,
      detail: "The answer wasn't valid JSON of the requested structure.",
    });
  }

  const usage = basic.raw.usage;
  checks.push({
    name: "Usage reporting",
    ok: usage !== null,
    detail: usage
      ? `Reports token usage (${usage.promptTokens} prompt, ${usage.completionTokens} output).`
      : "No token usage reported; costs will be estimated.",
  });
  if (basic.raw.reasoning || (usage && usage.reasoningTokens > 0)) {
    checks.push({
      name: "Reasoning when off",
      ok: null,
      detail:
        "The model reasoned even with reasoning switched off; it probably reasons by default. Consider reasoning mode 'on by default' or an explicit 'off' template.",
    });
    if (current.reasoningMode === "optional") suggestions.reasoningMode = "on_by_default";
  }

  // 2. Reasoning on (only if the model has a template for it).
  if (current.reasoningTemplates.onEnabled) {
    try {
      const r = await attempt(current, plan(TASK, 400), { enabled: true, effort: "low" });
      const reasoned = Boolean(r.raw.reasoning) || (r.raw.usage?.reasoningTokens ?? 0) > 0;
      checks.push({
        name: "Reasoning on",
        ok: true,
        detail: reasoned
          ? "Accepted; reasoning tokens were reported."
          : "Accepted, but no reasoning was reported (the model may not reason, or the provider hides it).",
      });
    } catch (error) {
      checks.push({
        name: "Reasoning on",
        ok: false,
        detail: `Rejected: ${(error as Error).message}`,
      });
    }
  }

  // 3. Deep checks: long prompt (silent truncation) and caching.
  if (options.deep) {
    const target = Math.min(Math.floor(current.contextWindow * 0.6), 24_000);
    const filler = Array.from(
      { length: Math.ceil(target / 12) },
      (_, i) => `Line ${i}: the lighthouse lamp turned slowly over the water.`,
    ).join("\n");
    const longPlan: RequestPlan = {
      ...plan(`${filler}\n\n${TASK}`),
      promptCacheKey: "trainslator-probe",
    };
    try {
      const first = await attempt(current, longPlan);
      const estimate = estimateTokens(filler);
      const reported = first.raw.usage?.promptTokens ?? null;
      if (reported !== null && reported < estimate * 0.6) {
        checks.push({
          name: "Long prompts",
          ok: false,
          detail: `Sent about ${estimate} tokens but the server counted ${reported}; it cuts long prompts. Raise the model's context size on the server.`,
        });
      } else {
        checks.push({
          name: "Long prompts",
          ok: true,
          detail: reported
            ? `A ${reported}-token prompt was accepted in full.`
            : "A long prompt was accepted.",
        });
      }
      const second = await attempt(current, longPlan);
      const cached = second.raw.usage?.cachedTokens ?? 0;
      checks.push({
        name: "Prompt caching",
        ok: cached > 0 ? true : null,
        detail:
          cached > 0
            ? `The repeated prompt reused ${cached} cached tokens.`
            : "No cached tokens reported for a repeated prompt. The provider may not cache, may not report it, or needs cache markers.",
      });
    } catch (error) {
      checks.push({ name: "Long prompts", ok: false, detail: (error as Error).message });
    }
  }

  return { checks, suggestions, latencyMs, requests };
}
