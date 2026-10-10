import { createHash, randomUUID } from "node:crypto";
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "openai";
import type { z } from "zod";
import { addUsage, emptyUsage, type Usage } from "../shared/schemas/common.ts";
import type { Connection, Model, StepSettings } from "../shared/schemas/settings.ts";
import type { Step } from "../shared/steps.ts";
import type { DataPaths } from "../store/paths.ts";
import type { ResponseCache } from "./cache.ts";
import type { CalibrationStore } from "./calibration.ts";
import type { ClientPool } from "./client.ts";
import { LlmError } from "./errors.ts";
import type { Lane, Limiter } from "./limiter.ts";
import { type CallLog, costOf } from "./log.ts";
import { buildRequestBody, outputLimit, type PromptBlock, type RequestPlan } from "./request.ts";
import {
  jsonCandidates,
  type NormalizedUsage,
  type RawResult,
  readCompletion,
  readStream,
} from "./response.ts";
import {
  describeSchema,
  fillMissingNulls,
  type JsonSchema,
  toStrictJsonSchema,
} from "./structured.ts";
import { estimateTokens, reasoningAllowance } from "./tokens.ts";

/** Everything the LLM layer needs, shared by all jobs. */
export interface LlmRuntime {
  paths: DataPaths;
  clients: ClientPool;
  limiter: Limiter;
  calibration: CalibrationStore;
  cache: ResponseCache;
  log: CallLog;
  /** Overridable waits (tests use short ones). */
  waits?: { rateLimitMs?: number; transportMs?: number };
}

export interface CallTarget {
  connection: Connection;
  model: Model;
  step: StepSettings;
}

export interface CallSpec<T> {
  projectId: string | null;
  step: Step;
  /** Short description for logs, e.g. "phase 3 · chapter 4 · chunk 2". */
  label: string;
  blocks: PromptBlock[];
  schema: z.ZodType<T>;
  schemaName: string;
  /** Expected answer size in tokens, without reasoning. */
  answerBudget: number;
  /** Extra checks; returned strings are problems sent back to the model in a repair turn. */
  validate?: (value: T) => string[];
  /**
   * Makes the best of an answer that failed the checks, instead of a repair
   * turn (which re-sends and re-generates the whole answer). Return null when
   * nothing usable is left; then the usual repair turns apply.
   */
  salvage?: (raw: string) => T | null;
  promptCacheKey?: string | null;
  /** Use the response cache (default true). Re-translate and re-run pass false. */
  useCache?: boolean;
  lane?: Lane;
  signal?: AbortSignal;
  /** Called after every request, e.g. to add usage to a job. */
  onUsage?: (usage: Usage) => void;
}

export interface CallResult<T> {
  value: T;
  usage: Usage;
  attempts: number;
  raw: string;
  fromCache: boolean;
}

const MAX_REPAIR_TURNS = 2;
const MAX_TRANSPORT_RETRIES = 2;
const MAX_RATE_LIMIT_WAITS = 5;

/** JSON objects in a reply, with left-out nullable keys filled in; for salvaging failed answers. */
export function replyCandidates(raw: string, schema: z.ZodType): unknown[] {
  const json = jsonSchemaFor(schema);
  return jsonCandidates(raw).map((c) => fillMissingNulls(c, json));
}

const schemaCache = new WeakMap<z.ZodType, JsonSchema>();
function jsonSchemaFor(schema: z.ZodType): JsonSchema {
  let json = schemaCache.get(schema);
  if (!json) {
    json = toStrictJsonSchema(schema);
    schemaCache.set(schema, json);
  }
  return json;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmError("aborted", "Cancelled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new LlmError("aborted", "Cancelled"));
      },
      { once: true },
    );
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

function requestHash(connection: Connection, body: Record<string, unknown>): string {
  const { stream: _s, stream_options: _o, ...rest } = body;
  const headers = connection.headers.filter((h) => !h.secret).map((h) => [h.name, h.value]);
  return hash(JSON.stringify([connection.baseUrl, headers, rest]));
}

function usageFrom(
  raw: NormalizedUsage | null,
  model: Model,
  promptEstimate: number,
  content: string,
): Usage {
  if (!raw) {
    return {
      calls: 1,
      promptTokens: promptEstimate,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: estimateTokens(content),
      reasoningTokens: 0,
      cost: null,
      estimated: true,
    };
  }
  return {
    calls: 1,
    promptTokens: raw.promptTokens,
    cachedTokens: raw.cachedTokens,
    cacheWriteTokens: raw.cacheWriteTokens,
    completionTokens: raw.completionTokens,
    reasoningTokens: raw.reasoningTokens,
    cost: costOf(raw, model.pricing),
    estimated: false,
  };
}

/** Maps SDK and network errors to LlmError kinds. */
/** The most output a step may ask for: the model's limit, or the step's own when lower. */
export function answerCap(target: CallTarget): number {
  return Math.min(target.model.maxOutputTokens, target.step.maxOutputTokens ?? Infinity);
}

/**
 * Calls with a budget; when the answer is cut off and there was room left
 * under the output limit, tries once more with the full limit.
 */
export async function withRoomToGrow<T>(
  target: CallTarget,
  budget: number,
  call: (answerBudget: number) => Promise<T>,
  onRetry?: () => void,
): Promise<T> {
  const cap = answerCap(target);
  try {
    return await call(Math.min(budget, cap));
  } catch (error) {
    if (!(error instanceof LlmError) || error.kind !== "truncated" || budget >= cap) throw error;
    onRetry?.();
    return call(cap);
  }
}

export function classifyError(
  error: unknown,
  timedOut: string | null,
  externalSignal?: AbortSignal,
): LlmError {
  if (error instanceof LlmError) return error;
  if (timedOut) return new LlmError("transport", timedOut, { cause: error });
  if (externalSignal?.aborted) return new LlmError("aborted", "Cancelled", { cause: error });
  if (error instanceof APIUserAbortError)
    return new LlmError("aborted", "Cancelled", { cause: error });
  if (error instanceof RateLimitError) {
    return new LlmError("rate_limit", `Rate limited by the provider: ${error.message}`, {
      status: 429,
      cause: error,
    });
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new LlmError("auth", `The provider rejected the API key: ${error.message}`, {
      status: error.status,
      cause: error,
    });
  }
  if (
    error instanceof BadRequestError ||
    error instanceof NotFoundError ||
    error instanceof UnprocessableEntityError
  ) {
    return new LlmError("bad_request", `The provider rejected the request: ${error.message}`, {
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof APIConnectionError) {
    return new LlmError("transport", `Couldn't reach the provider: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof APIError) {
    return new LlmError("transport", `Provider error: ${error.message}`, {
      status: error.status ?? null,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError("transport", message, { cause: error });
}

function retryAfterMs(error: LlmError, fallback: number): number {
  const cause = error.cause;
  if (cause instanceof APIError && cause.headers) {
    const header = cause.headers.get?.("retry-after");
    const seconds = header ? Number(header) : Number.NaN;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 5 * 60_000);
  }
  return fallback;
}

/** Sends one request with a total deadline and (for streams) an idle watchdog. */
export async function send(
  rt: LlmRuntime,
  connection: Connection,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<RawResult> {
  const client = rt.clients.get(connection);
  const controller = new AbortController();
  let timedOut: string | null = null;
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = `No complete answer after ${connection.timeoutSec} s (the connection's time limit).`;
    controller.abort();
  }, connection.timeoutSec * 1000);
  let idle: NodeJS.Timeout | null = null;
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = `No data from the provider for ${connection.idleTimeoutSec} s.`;
      controller.abort();
    }, connection.idleTimeoutSec * 1000);
  };
  try {
    const options = {
      signal: controller.signal,
      maxRetries: connection.maxRetries,
      timeout: connection.timeoutSec * 1000,
    };
    if (body.stream) {
      resetIdle();
      const stream = await client.chat.completions.create(
        body as unknown as Parameters<typeof client.chat.completions.create>[0] & { stream: true },
        options,
      );
      const result = await readStream(stream as AsyncIterable<unknown>, resetIdle);
      // An aborted stream can end quietly instead of throwing.
      if (timedOut) throw new LlmError("transport", timedOut);
      if (signal?.aborted) throw new LlmError("aborted", "Cancelled");
      return result;
    }
    const completion = await client.chat.completions.create(
      body as unknown as Parameters<typeof client.chat.completions.create>[0] & { stream?: false },
      options,
    );
    return readCompletion(completion);
  } catch (error) {
    throw classifyError(error, timedOut, signal);
  } finally {
    clearTimeout(deadline);
    if (idle) clearTimeout(idle);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

interface Picked<T> {
  ok: boolean;
  value?: T;
  problems: string[];
}

function pick<T>(
  content: string,
  schema: z.ZodType<T>,
  jsonSchema: JsonSchema,
  validate?: (value: T) => string[],
): Picked<T> {
  const candidates = jsonCandidates(content).map((c) => fillMissingNulls(c, jsonSchema));
  if (candidates.length === 0) {
    return { ok: false, problems: ["The reply wasn't a JSON object."] };
  }
  let firstProblems: string[] | null = null;
  for (const candidate of candidates) {
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      firstProblems ??= parsed.error.issues
        .slice(0, 12)
        .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
      continue;
    }
    const problems = validate ? validate(parsed.data) : [];
    if (problems.length === 0) return { ok: true, value: parsed.data, problems: [] };
    firstProblems ??= problems;
  }
  return {
    ok: false,
    problems: firstProblems ?? ["The reply didn't match the required structure."],
  };
}

function repairMessage(problems: string[]): string {
  return `Your previous reply had problems:\n${problems
    .slice(0, 30)
    .map((p) => `- ${p}`)
    .join("\n")}\nReply again with the complete, corrected JSON object only.`;
}

/**
 * Sends a structured request and returns a validated value. Handles the
 * response cache, limiter, retries for transport errors and rate limits,
 * repair turns for invalid output, refusals, truncation and reasoning that
 * used up the output budget.
 */
export async function callStructured<T>(
  rt: LlmRuntime,
  target: CallTarget,
  spec: CallSpec<T>,
): Promise<CallResult<T>> {
  const { connection, model, step } = target;
  const jsonSchema = jsonSchemaFor(spec.schema);
  const allowance = reasoningAllowance({
    enabled: step.reasoning.enabled,
    effort: step.reasoning.effort,
    budgetTokens: step.reasoning.budgetTokens,
    mode: model.reasoningMode,
    samples: rt.calibration.reasoningSamples(model.id, spec.step),
  });
  let plan: RequestPlan = {
    blocks: spec.blocks,
    schemaName: spec.schemaName,
    jsonSchema,
    answerBudget: spec.answerBudget,
    reasoningAllowance: allowance,
    repair: [],
    promptCacheKey: spec.promptCacheKey ?? null,
  };

  const factor = rt.calibration.tokenFactor(model.id);
  const schemaText = describeSchema(jsonSchema);
  const rawEstimate = estimateTokens(spec.blocks.map((b) => b.text).join("\n") + schemaText);
  const promptEstimate = Math.ceil(rawEstimate * factor);
  const limit = outputLimit(model, step, plan);
  if (promptEstimate + limit > model.contextWindow) {
    throw new LlmError(
      "context_overflow",
      `The prompt (about ${promptEstimate.toLocaleString("en")} tokens) plus room for the answer (${limit.toLocaleString("en")}) doesn't fit ${model.label}'s context window (${model.contextWindow.toLocaleString("en")} tokens).`,
    );
  }
  const blockTokens = spec.blocks.map((b) => ({
    label: b.label,
    tokens: Math.ceil(estimateTokens(b.text) * factor),
  }));

  const firstBody = buildRequestBody(connection, model, step, plan, false);
  const cacheKey = requestHash(connection, firstBody);
  const useCache = spec.useCache !== false && spec.projectId !== null;

  if (useCache) {
    const hit = await rt.cache.get(spec.projectId!, cacheKey);
    if (hit) {
      const picked = pick(hit.raw, spec.schema, jsonSchema, spec.validate);
      if (picked.ok) {
        await rt.log.append({
          id: `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
          at: new Date().toISOString(),
          projectId: spec.projectId,
          step: spec.step,
          label: spec.label,
          modelId: model.id,
          modelName: model.modelName,
          attempt: 0,
          kind: "cache_hit",
          requestHash: cacheKey,
          blockTokens,
          params: {},
          finishReason: "stop",
          latencyMs: 0,
          usage: emptyUsage(),
          error: null,
        });
        return {
          value: picked.value as T,
          usage: emptyUsage(),
          attempts: 0,
          raw: hit.raw,
          fromCache: true,
        };
      }
    }
  }

  let usage = emptyUsage();
  let attempts = 0;
  let repairs = 0;
  let transportRetries = 0;
  let rateWaits = 0;
  let refusalRetried = false;
  let reasoningRetried = false;
  const waits = {
    rateLimitMs: rt.waits?.rateLimitMs ?? 60_000,
    transportMs: rt.waits?.transportMs ?? 3000,
  };

  for (;;) {
    if (spec.signal?.aborted) throw new LlmError("aborted", "Cancelled");
    attempts++;
    const body = buildRequestBody(connection, model, step, plan, connection.stream);
    const started = Date.now();
    const callId = `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const logBase = {
      id: callId,
      at: new Date(started).toISOString(),
      projectId: spec.projectId,
      step: spec.step,
      label: spec.label,
      modelId: model.id,
      modelName: model.modelName,
      attempt: attempts,
      kind: "request" as const,
      requestHash: cacheKey,
      blockTokens,
      params: {
        maxTokens: body[model.maxTokensParam],
        reasoning: step.reasoning,
        temperature: body.temperature ?? null,
        repairTurn: plan.repair.length,
        stream: Boolean(body.stream),
      },
    };

    let raw: RawResult;
    const release = await rt.limiter
      .acquire(model.id, spec.lane ?? "normal", spec.signal)
      .catch((error: Error) => {
        throw error.name === "AbortError" ? new LlmError("aborted", "Cancelled") : error;
      });
    try {
      raw = await send(rt, connection, body, spec.signal);
    } catch (error) {
      release();
      const err = error instanceof LlmError ? error : classifyError(error, null, spec.signal);
      await rt.log.append({
        ...logBase,
        finishReason: null,
        latencyMs: Date.now() - started,
        usage: emptyUsage(),
        error: `${err.kind}: ${err.message}`,
      });
      if (err.kind === "transport" && transportRetries < MAX_TRANSPORT_RETRIES) {
        transportRetries++;
        await sleep(waits.transportMs * transportRetries, spec.signal);
        continue;
      }
      if (err.kind === "rate_limit" && rateWaits < MAX_RATE_LIMIT_WAITS) {
        rateWaits++;
        rt.limiter.backoff(model.id);
        await sleep(retryAfterMs(err, waits.rateLimitMs), spec.signal);
        continue;
      }
      throw err;
    }
    release();
    rt.limiter.recover(model.id);

    const callUsage = usageFrom(raw.usage, model, promptEstimate, raw.content);
    usage = addUsage(usage, callUsage);
    spec.onUsage?.(callUsage);
    if (raw.usage) {
      if (plan.repair.length === 0)
        rt.calibration.recordPrompt(model.id, rawEstimate, raw.usage.promptTokens);
      if (raw.usage.reasoningTokens > 0)
        rt.calibration.recordReasoning(model.id, spec.step, raw.usage.reasoningTokens);
    }
    const log = (error: string | null) =>
      rt.log.append(
        {
          ...logBase,
          finishReason: raw.finishReason,
          latencyMs: Date.now() - started,
          usage: callUsage,
          error,
        },
        {
          request: body,
          response: {
            content: raw.content,
            reasoning: raw.reasoning,
            refusal: raw.refusal,
            finishReason: raw.finishReason,
            usage: raw.usage,
          },
        },
      );

    // Refusals and content filters.
    if (
      raw.refusal ||
      raw.finishReason === "content_filter" ||
      (raw.finishReason === "refusal" && !raw.content.trim())
    ) {
      await log("refusal");
      if (!refusalRetried) {
        refusalRetried = true;
        continue;
      }
      throw new LlmError("refusal", raw.refusal ?? "The provider refused or filtered the answer.", {
        raw: raw.content,
      });
    }
    if (raw.finishReason === "error") {
      await log("provider error mid-answer");
      if (transportRetries < MAX_TRANSPORT_RETRIES) {
        transportRetries++;
        await sleep(waits.transportMs * transportRetries, spec.signal);
        continue;
      }
      throw new LlmError("transport", "The provider ended the answer with an error.", {
        raw: raw.content,
      });
    }
    // Out of tokens.
    if (raw.finishReason === "length") {
      const reasoningHeavy =
        !raw.content.trim() ||
        (raw.usage !== null &&
          raw.usage.completionTokens > 0 &&
          raw.usage.reasoningTokens >= 0.8 * raw.usage.completionTokens);
      if (reasoningHeavy) {
        await log("reasoning used up the output limit");
        if (!reasoningRetried) {
          reasoningRetried = true;
          plan = {
            ...plan,
            reasoningAllowance: Math.max(
              plan.reasoningAllowance * 2,
              plan.reasoningAllowance + 8000,
            ),
          };
          continue;
        }
        throw new LlmError(
          "reasoning_exhausted",
          "The model spent its whole output limit on reasoning. Lower the reasoning effort or raise the output limit.",
          { raw: raw.content },
        );
      }
      await log("answer cut off (output limit)");
      throw new LlmError("truncated", "The answer was cut off by the output limit.", {
        raw: raw.content,
      });
    }
    // Silent prompt truncation by the server (e.g. Ollama's num_ctx).
    if (
      raw.usage &&
      raw.usage.promptTokens > 0 &&
      promptEstimate > 3000 &&
      raw.usage.promptTokens < promptEstimate * 0.6
    ) {
      await log("prompt truncated by the server");
      throw new LlmError(
        "context_truncated",
        `The server reports ${raw.usage.promptTokens} prompt tokens but about ${promptEstimate} were sent; it probably cut the prompt. Check the model's context size on the server.`,
      );
    }

    const picked = pick(raw.content, spec.schema, jsonSchema, spec.validate);
    if (picked.ok) {
      await log(null);
      if (useCache)
        await rt.cache.put(spec.projectId!, cacheKey, {
          raw: raw.content,
          model: model.modelName,
          at: new Date().toISOString(),
        });
      return { value: picked.value as T, usage, attempts, raw: raw.content, fromCache: false };
    }
    await log(`invalid output: ${picked.problems.slice(0, 3).join("; ")}`);
    const rescued = spec.salvage?.(raw.content) ?? null;
    if (rescued !== null) {
      // Not cached: a cache hit must pass the checks.
      return { value: rescued, usage, attempts, raw: raw.content, fromCache: false };
    }
    if (repairs < MAX_REPAIR_TURNS) {
      repairs++;
      plan = {
        ...plan,
        repair: [
          ...plan.repair,
          { previous: raw.content.slice(0, 60_000), problems: repairMessage(picked.problems) },
        ],
      };
      continue;
    }
    throw new LlmError(
      "invalid_output",
      `The model's answer didn't pass the checks: ${picked.problems.slice(0, 5).join("; ")}`,
      {
        raw: raw.content,
      },
    );
  }
}
