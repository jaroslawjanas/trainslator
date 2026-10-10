import type { Connection } from "../shared/schemas/settings.ts";
import { longFetch, resolveApiKey, rootUrl } from "./client.ts";
import { isLlmError, LlmError, wrongAddressError } from "./errors.ts";
import type { RawResult, ToolCall } from "./response.ts";
import type { Watch } from "./watch.ts";

/**
 * Ollama's own API, on this computer (http://localhost:11434) or on Ollama
 * Cloud (https://ollama.com with a key). Streams arrive as one JSON object
 * per line; the last one carries done_reason and the token counts.
 */

type Dict = Record<string, unknown>;

function base(connection: Connection): string {
  return rootUrl(connection, /\/(v1|api)$/);
}

function headers(connection: Connection): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  if (connection.apiKey.kind !== "none") out.authorization = `Bearer ${resolveApiKey(connection)}`;
  for (const h of connection.headers) out[h.name] = h.value;
  return out;
}

function errorFor(status: number, message: string): LlmError {
  const text = `Ollama: ${message}`;
  if (status === 401 || status === 403)
    return new LlmError("auth", `${text} (check the API key)`, { status });
  if (status === 429) return new LlmError("rate_limit", text, { status });
  if (status === 404 || status === 405) return wrongAddressError(status, text);
  if (status === 400 || status === 422) return new LlmError("bad_request", text, { status });
  return new LlmError("transport", text, { status });
}

async function request(
  connection: Connection,
  path: string,
  init: { method: string; body?: string; signal?: AbortSignal },
): Promise<Response> {
  const url = `${base(connection)}${path}`;
  let res: Response;
  try {
    res = await longFetch(url, { ...init, headers: headers(connection) });
  } catch (error) {
    // Aborts (cancel, timeouts) are classified by the caller.
    if (init.signal?.aborted) throw error;
    throw new LlmError(
      "transport",
      `Couldn't reach Ollama at ${base(connection)}: ${(error as Error).message}`,
      {
        cause: error,
      },
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text.trim() || res.statusText;
    try {
      const parsed = JSON.parse(text) as Dict;
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // not JSON
    }
    throw errorFor(res.status, `${res.status} ${message}`);
  }
  return res;
}

function finishReason(done: unknown): string | null {
  if (done === "length") return "length";
  if (typeof done === "string") return "stop";
  return null;
}

function usageOf(last: Dict): RawResult["usage"] {
  if (typeof last.prompt_eval_count !== "number" && typeof last.eval_count !== "number")
    return null;
  const prompt = typeof last.prompt_eval_count === "number" ? last.prompt_eval_count : 0;
  // Prompt tokens read from Ollama's cache, part of prompt_eval_count.
  const cached =
    typeof last.prompt_eval_cached_count === "number" ? last.prompt_eval_cached_count : 0;
  return {
    promptTokens: Math.max(prompt, cached),
    completionTokens: typeof last.eval_count === "number" ? last.eval_count : 0,
    reasoningTokens: 0,
    cachedTokens: cached,
    cacheWriteTokens: 0,
    cost: null,
  };
}

function message(chunk: Dict): { content: string; thinking: string; toolCalls: Dict[] } {
  const m = (chunk.message ?? {}) as Dict;
  return {
    content: typeof m.content === "string" ? m.content : "",
    thinking: typeof m.thinking === "string" ? m.thinking : "",
    toolCalls: Array.isArray(m.tool_calls) ? (m.tool_calls as Dict[]) : [],
  };
}

/**
 * Ollama gives tool arguments as an object and may leave out ids. The
 * message sent back keeps Ollama's own shape.
 */
function withTools(result: RawResult, raw: Dict[]): RawResult {
  if (raw.length === 0) return result;
  const toolCalls: ToolCall[] = raw.map((call, i) => {
    const fn = (call.function ?? {}) as Dict;
    return {
      id: typeof call.id === "string" && call.id ? call.id : `call_${i}`,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: JSON.stringify(fn.arguments ?? {}),
    };
  });
  return {
    ...result,
    toolCalls,
    finishReason: "tool_calls",
    replay: {
      role: "assistant",
      content: result.content,
      ...(result.reasoning ? { thinking: result.reasoning } : {}),
      tool_calls: raw,
    },
  };
}

/** Models that turned down a thinking level; they get plain "thinking on" instead. */
const withoutThinkLevels = new Set<string>();

export async function sendOllama(
  connection: Connection,
  body: Record<string, unknown>,
  watch: Watch,
  onText?: (chars: number) => void,
): Promise<RawResult> {
  watch.activity();
  const key = `${connection.id}:${String(body.model)}`;
  let sent =
    typeof body.think === "string" && withoutThinkLevels.has(key) ? { ...body, think: true } : body;
  const post = () =>
    request(connection, "/api/chat", {
      method: "POST",
      body: JSON.stringify(sent),
      signal: watch.signal,
    });
  let res: Response;
  try {
    res = await post();
  } catch (error) {
    const levelRefused =
      typeof sent.think === "string" &&
      isLlmError(error, "bad_request") &&
      /think/i.test(error.message);
    if (!levelRefused) throw error;
    withoutThinkLevels.add(key);
    sent = { ...sent, think: true };
    res = await post();
  }
  if (!body.stream) {
    const chunk = (await res.json()) as Dict;
    const m = message(chunk);
    return withTools(
      {
        content: m.content,
        reasoning: m.thinking,
        refusal: null,
        finishReason: finishReason(chunk.done_reason),
        usage: usageOf(chunk),
        model: typeof chunk.model === "string" ? chunk.model : null,
      },
      m.toolCalls,
    );
  }

  let content = "";
  let reasoning = "";
  let last: Dict = {};
  const toolCalls: Dict[] = [];
  let buffer = "";
  const decoder = new TextDecoder();
  const handle = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as Dict;
    if (typeof chunk.error === "string")
      throw new LlmError("transport", `Ollama: ${chunk.error}`, { raw: content });
    const m = message(chunk);
    content += m.content;
    reasoning += m.thinking;
    toolCalls.push(...m.toolCalls);
    if (onText && m.content.length + m.thinking.length > 0)
      onText(m.content.length + m.thinking.length);
    if (chunk.done) last = chunk;
  };
  if (!res.body) throw new LlmError("transport", "Ollama sent an empty response.");
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    watch.activity();
    buffer += decoder.decode(part, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  handle(buffer + decoder.decode());
  return withTools(
    {
      content,
      reasoning,
      refusal: null,
      finishReason: finishReason(last.done_reason),
      usage: usageOf(last),
      model: typeof last.model === "string" ? last.model : null,
    },
    toolCalls,
  );
}

/** Model names from /api/tags (installed models locally, available models on Ollama Cloud). */
export async function listOllamaModels(connection: Connection): Promise<string[]> {
  const res = await request(connection, "/api/tags", {
    method: "GET",
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as { models?: Dict[] };
  return (data.models ?? [])
    .map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : ""))
    .filter(Boolean);
}
