import { createHash, randomUUID } from "node:crypto";
import { addUsage, emptyUsage, type Usage } from "../shared/schemas/common.ts";
import type { Connection, Model, StepSettings } from "../shared/schemas/settings.ts";
import { STEP_INFO, type Step } from "../shared/steps.ts";
import { currentJobId } from "./activity.ts";
import { classifyError, type LlmRuntime, send, usageFrom } from "./call.ts";
import { LlmError } from "./errors.ts";
import { thinkingRoomFactor } from "./presets.ts";
import {
  bodyOutputLimit,
  buildRequestBody,
  type PromptBlock,
  type RequestPlan,
  type ToolSpec,
} from "./request.ts";
import { type RawResult, stripReasoning } from "./response.ts";
import { estimateTokens, reasoningAllowance } from "./tokens.ts";

/**
 * The advisor: a strong model the steps' models can consult through a tool
 * call. It sees only the question, so the asking model must make it
 * self-contained. A failed consultation never fails the asking request: the
 * asking model reads what went wrong and decides on its own.
 */

export const ADVISOR_TOOL = "ask_advisor";

export interface AdvisorTarget {
  connection: Connection;
  model: Model;
  step: StepSettings;
  /** Most consultations within one request. */
  maxConsultations: number;
}

/** Room for one piece of advice, without reasoning. */
const ADVICE_BUDGET = 1500;
const MAX_ATTEMPTS = 3;

export function advisorTool(maxConsultations: number): ToolSpec {
  const times = maxConsultations === 1 ? "once" : `at most ${maxConsultations} times`;
  return {
    name: ADVISOR_TOOL,
    description: `Ask a more capable model for advice before committing to a decision that matters and that you're unsure about: a hard or ambiguous passage, wordplay, an invented name or term, a conflict between the knowledge bases and the text. The advisor sees only your question, nothing else from this conversation, so make it self-contained: quote the passage and the knowledge-base entries involved, say what you're considering and what exactly you're unsure about. You can ask ${times} in this answer; don't ask about what you can decide yourself. After the advice, continue with your answer in the required format.`,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, with everything the advisor needs to answer it.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  };
}

/** The question from a tool call's arguments; the raw text when they aren't JSON. */
export function questionOf(args: string): string {
  try {
    const parsed = JSON.parse(args) as { question?: unknown };
    if (typeof parsed.question === "string") return parsed.question.trim();
  } catch {
    // not JSON
  }
  return args.trim();
}

function blocks(step: Step, question: string): PromptBlock[] {
  return [
    {
      role: "system",
      label: "advisor",
      text: `You advise another AI model that works on translating a book. Its task: ${STEP_INFO[step].description} It asks you because it's unsure. You see only its question. Answer directly: your recommendation first, then the reason in a few sentences. If the question lacks something you need, say what, and still give your best recommendation. Plain text, no preamble.`,
    },
    { role: "user", label: "question", text: question },
  ];
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

export interface AdviceRequest {
  projectId: string | null;
  /** The asking step; the advice is logged and counted under it. */
  step: Step;
  /** The asking request's label. */
  label: string;
  signal?: AbortSignal;
}

/** Asks the advisor one question; the answer, or what went wrong, as text. */
export async function consultAdvisor(
  rt: LlmRuntime,
  advisor: AdvisorTarget,
  question: string,
  request: AdviceRequest,
): Promise<{ text: string; usage: Usage }> {
  const { connection, model, step } = advisor;
  const plan: RequestPlan = {
    blocks: blocks(request.step, question),
    schemaName: "advice",
    jsonSchema: null,
    answerBudget: ADVICE_BUDGET,
    reasoningAllowance: reasoningAllowance({
      enabled: step.reasoning.enabled,
      effort: step.reasoning.effort,
      budgetTokens: step.reasoning.budgetTokens,
      mode: model.reasoningMode,
      samples: [],
      factor: thinkingRoomFactor(connection.kind),
    }),
    turns: [],
    promptCacheKey: null,
  };
  const body = buildRequestBody(connection, model, step, plan, connection.stream);
  const promptEstimate = estimateTokens(plan.blocks.map((b) => b.text).join("\n"));
  const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 40);
  const label = `Advisor · ${request.label}`.slice(0, 160);
  let usage = emptyUsage();

  for (let attempt = 1; ; attempt++) {
    const queued = Date.now();
    const callId = `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const jobId = currentJobId();
    const activity = rt.activity.begin({
      id: callId,
      jobId,
      projectId: request.projectId,
      step: request.step,
      label,
      modelName: model.modelName,
      reasoning: { enabled: step.reasoning.enabled, effort: step.reasoning.effort },
      attempt,
      queuedAt: new Date(queued).toISOString(),
    });
    let release: () => void;
    try {
      // The asking model waits for the advice, so it goes ahead of queued work.
      release = await rt.limiter.acquire(connection.id, "interactive", request.signal);
    } catch (error) {
      activity.end();
      throw (error as Error).name === "AbortError" ? new LlmError("aborted", "Cancelled") : error;
    }
    activity.sent();
    const started = Date.now();
    const entry = {
      id: callId,
      at: new Date(started).toISOString(),
      projectId: request.projectId,
      jobId,
      waitMs: started - queued,
      step: request.step,
      label,
      modelId: model.id,
      modelName: model.modelName,
      attempt,
      kind: "request" as const,
      requestHash,
      blockTokens: plan.blocks.map((b) => ({ label: b.label, tokens: estimateTokens(b.text) })),
      params: {
        maxTokens: bodyOutputLimit(body),
        reasoning: step.reasoning,
        advisor: true,
        stream: Boolean(body.stream),
      },
    };
    let raw: RawResult;
    try {
      raw = await send(rt, connection, body, request.signal, (chars) => activity.received(chars));
    } catch (error) {
      activity.end();
      release();
      const err = error instanceof LlmError ? error : classifyError(error, null, request.signal);
      await rt.log.append({
        ...entry,
        finishReason: null,
        latencyMs: Date.now() - started,
        usage: emptyUsage(),
        error: `${err.kind}: ${err.message}`,
      });
      if (err.kind === "aborted") throw err;
      if ((err.kind === "transport" || err.kind === "rate_limit") && attempt < MAX_ATTEMPTS) {
        if (err.kind === "rate_limit") rt.limiter.backoff(connection.id);
        await sleep(
          err.kind === "rate_limit"
            ? (rt.waits?.rateLimitMs ?? 60_000)
            : (rt.waits?.transportMs ?? 3000) * attempt,
          request.signal,
        );
        continue;
      }
      return { text: `The advisor couldn't answer (${err.message}). Decide on your own.`, usage };
    }
    release();
    activity.end();
    rt.limiter.recover(connection.id);
    const callUsage = usageFrom(raw.usage, model, promptEstimate, raw.content);
    usage = addUsage(usage, callUsage);
    await rt.log.append(
      {
        ...entry,
        finishReason: raw.finishReason,
        latencyMs: Date.now() - started,
        usage: callUsage,
        error: null,
      },
      {
        request: body,
        response: { content: raw.content, reasoning: raw.reasoning, usage: raw.usage },
      },
    );
    const text = stripReasoning(raw.content).trim();
    const cutOff = raw.finishReason === "length";
    if (!text)
      return {
        text: cutOff
          ? "The advisor ran out of room before answering. Decide on your own."
          : "The advisor gave no answer. Decide on your own.",
        usage,
      };
    return { text: cutOff ? `${text}\n(The advice was cut off.)` : text, usage };
  }
}
