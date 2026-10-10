import Anthropic from "@anthropic-ai/sdk";
import type { Pricing } from "../shared/schemas/settings.ts";
import { LlmError } from "./errors.ts";
import type { RawResult } from "./response.ts";
import type { Watch } from "./watch.ts";

/**
 * Anthropic's Messages API through the official SDK. The request body is
 * built in request.ts (system and user blocks with cache breakpoints,
 * output_config.format for the JSON schema, thinking and effort from the
 * model's templates); here it is sent, streamed, and turned into a RawResult.
 */

/**
 * List prices in USD per million tokens (Anthropic, October 2026), filled in
 * when one of these models is picked; they can be edited per model. Cache
 * writes are priced for the default 5-minute cache lifetime. Claude Haiku 5.5
 * costs more for prompts over 100K tokens.
 */
const KNOWN_PRICES: Record<string, Pricing> = {
  "claude-fable-5-1": {
    inputPerM: 10,
    cachedInputPerM: 0.25,
    cacheWritePerM: 12.5,
    outputPerM: 50,
  },
  "claude-opus-5-5": { inputPerM: 4, cachedInputPerM: 0.2, cacheWritePerM: 5, outputPerM: 20 },
  "claude-opus-5": { inputPerM: 5, cachedInputPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25 },
  "claude-opus-4-8": { inputPerM: 5, cachedInputPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25 },
  "claude-sonnet-5-5": { inputPerM: 2, cachedInputPerM: 0.2, cacheWritePerM: 2.5, outputPerM: 10 },
  "claude-sonnet-5": { inputPerM: 2, cachedInputPerM: 0.2, cacheWritePerM: 2.5, outputPerM: 10 },
  "claude-haiku-5-5": {
    inputPerM: 0.1,
    cachedInputPerM: 0.01,
    cacheWritePerM: 0.125,
    outputPerM: 0.5,
  },
  "claude-haiku-4-5": { inputPerM: 1, cachedInputPerM: 0.1, cacheWritePerM: 1.25, outputPerM: 5 },
};

function finishReason(stop: Anthropic.StopReason | null): string | null {
  switch (stop) {
    case null:
      return null;
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

export function fromMessage(message: Anthropic.Message): RawResult {
  let content = "";
  let reasoning = "";
  for (const block of message.content) {
    if (block.type === "text") content += block.text;
    else if (block.type === "thinking") reasoning += block.thinking;
  }
  const u = message.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    content,
    reasoning,
    refusal:
      message.stop_reason === "refusal"
        ? (message.stop_details?.explanation ?? "The model declined to answer.")
        : null,
    finishReason: finishReason(message.stop_reason),
    usage: {
      // input_tokens counts only the uncached part of the prompt.
      promptTokens: u.input_tokens + cacheRead + cacheWrite,
      completionTokens: u.output_tokens,
      reasoningTokens: 0,
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cost: null,
    },
    model: message.model,
  };
}

/** SDK errors as LlmErrors; aborts stay as they are so the caller can tell a timeout from a cancel. */
function classify(error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.RateLimitError)
    return new LlmError("rate_limit", `Rate limited by Anthropic: ${error.message}`, {
      status: 429,
      cause: error,
    });
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  )
    return new LlmError("auth", `Anthropic rejected the API key: ${error.message}`, {
      status: error.status,
      cause: error,
    });
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.UnprocessableEntityError
  )
    return new LlmError("bad_request", `Anthropic rejected the request: ${error.message}`, {
      status: error.status,
      cause: error,
    });
  if (error instanceof Anthropic.APIConnectionError)
    return new LlmError("transport", `Couldn't reach Anthropic: ${error.message}`, {
      cause: error,
    });
  if (error instanceof Anthropic.APIError)
    return new LlmError("transport", `Anthropic error: ${error.message}`, {
      status: error.status ?? null,
      cause: error,
    });
  return error;
}

export async function sendAnthropic(
  client: Anthropic,
  body: Record<string, unknown>,
  watch: Watch,
  options: { maxRetries: number; timeoutMs: number },
): Promise<RawResult> {
  const { stream, ...params } = body;
  const requestOptions = {
    signal: watch.signal,
    maxRetries: options.maxRetries,
    timeout: options.timeoutMs,
  };
  try {
    if (stream) {
      watch.activity();
      const messageStream = client.messages.stream(
        params as unknown as Anthropic.MessageStreamParams,
        requestOptions,
      );
      for await (const _event of messageStream) watch.activity();
      return fromMessage(await messageStream.finalMessage());
    }
    const message = await client.messages.create(
      { ...params, stream: false } as unknown as Anthropic.MessageCreateParamsNonStreaming,
      requestOptions,
    );
    return fromMessage(message);
  } catch (error) {
    throw classify(error);
  }
}

export interface AnthropicModel {
  id: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: Pricing | null;
}

export async function listAnthropicModels(client: Anthropic): Promise<AnthropicModel[]> {
  const out: AnthropicModel[] = [];
  try {
    for await (const m of client.models.list()) {
      out.push({
        id: m.id,
        contextWindow: m.max_input_tokens,
        maxOutputTokens: m.max_tokens,
        pricing: KNOWN_PRICES[m.id] ?? null,
      });
    }
  } catch (error) {
    throw classify(error);
  }
  return out;
}
