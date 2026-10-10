/**
 * Turning provider responses into text, usage and JSON. Providers differ in
 * where they report usage, cached tokens and reasoning, and models sometimes
 * leak reasoning or add preambles; everything here is defensive.
 */

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** Cost reported by the provider (OpenRouter), in USD. */
  cost: number | null;
}

export interface RawResult {
  content: string;
  reasoning: string;
  refusal: string | null;
  finishReason: string | null;
  usage: NormalizedUsage | null;
  model: string | null;
}

type Dict = Record<string, unknown>;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function obj(value: unknown): Dict {
  return value && typeof value === "object" ? (value as Dict) : {};
}

export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Dict;
  const promptDetails = obj(u.prompt_tokens_details);
  const completionDetails = obj(u.completion_tokens_details);
  const cached =
    num(promptDetails.cached_tokens) ||
    num(u.prompt_cache_hit_tokens) ||
    num(u.cache_read_input_tokens);
  const cacheWrite = num(promptDetails.cache_write_tokens) || num(u.cache_creation_input_tokens);
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(completionDetails.reasoning_tokens),
    cachedTokens: cached,
    cacheWriteTokens: cacheWrite,
    cost: typeof u.cost === "number" ? u.cost : null,
  };
}

function reasoningOf(delta: Dict): string {
  const r = delta.reasoning_content ?? delta.reasoning;
  return typeof r === "string" ? r : "";
}

/** Accumulates a streamed response. `onActivity` is called for every chunk (idle watchdog). */
export async function readStream(
  stream: AsyncIterable<unknown>,
  onActivity: () => void,
): Promise<RawResult> {
  let content = "";
  let reasoning = "";
  let refusal: string | null = null;
  let finishReason: string | null = null;
  let usage: NormalizedUsage | null = null;
  let model: string | null = null;
  for await (const chunk of stream) {
    onActivity();
    const c = obj(chunk);
    if (typeof c.model === "string") model = c.model;
    const u = normalizeUsage(c.usage);
    if (u) usage = u;
    if (c.error) {
      const e = obj(c.error);
      throw Object.assign(
        new Error(String(e.message ?? "The provider reported an error mid-stream.")),
        { streamError: true },
      );
    }
    const choices = Array.isArray(c.choices) ? (c.choices as Dict[]) : [];
    const choice = choices[0];
    if (!choice) continue;
    const delta = obj(choice.delta);
    if (typeof delta.content === "string") content += delta.content;
    reasoning += reasoningOf(delta);
    if (typeof delta.refusal === "string") refusal = (refusal ?? "") + delta.refusal;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
  }
  return { content, reasoning, refusal, finishReason, usage, model };
}

export function readCompletion(completion: unknown): RawResult {
  const c = obj(completion);
  const choices = Array.isArray(c.choices) ? (c.choices as Dict[]) : [];
  const choice = choices[0] ?? {};
  const message = obj(choice.message);
  return {
    content: typeof message.content === "string" ? message.content : "",
    reasoning: reasoningOf(message),
    refusal: typeof message.refusal === "string" ? message.refusal : null,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: normalizeUsage(c.usage),
    model: typeof c.model === "string" ? c.model : null,
  };
}

// ---------------------------------------------------------------------------
// Reasoning leaks and JSON extraction
// ---------------------------------------------------------------------------

const REASONING_TAGS = ["think", "thinking", "thought", "reasoning"];

/** Removes leaked reasoning: <think> blocks, a lone closing tag (template added the opening one), gpt-oss channels. */
export function stripReasoning(content: string): string {
  let text = content;
  // gpt-oss style channels: keep only the final channel when present.
  const finalIdx = text.lastIndexOf("<|channel|>final<|message|>");
  if (finalIdx >= 0) {
    text = text.slice(finalIdx + "<|channel|>final<|message|>".length);
    text = text.replace(/<\|(end|return)\|>[\s\S]*$/, "");
  } else {
    text = text.replace(/<\|channel\|>analysis<\|message\|>[\s\S]*?(<\|end\|>|$)/g, "");
  }
  for (const tag of REASONING_TAGS) {
    const close = new RegExp(`</${tag}\\s*>`, "gi");
    const open = new RegExp(`<${tag}(\\s[^>]*)?>`, "i");
    const closes = [...text.matchAll(close)];
    const last = closes[closes.length - 1];
    if (last && last.index !== undefined) {
      const firstOpen = open.exec(text);
      if (!firstOpen || firstOpen.index > last.index) {
        // Closing tag without an opening one: everything before it is reasoning.
        text = text.slice(last.index + last[0].length);
        continue;
      }
    }
    text = text.replace(new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`, "gi"), "");
  }
  return text;
}

/** All complete top-level JSON objects in the text, found with a string-aware scanner. */
export function findJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Parsed JSON candidates from a model reply, best first: the whole reply,
 * then objects found after removing leaked reasoning (largest first).
 */
export function jsonCandidates(content: string): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const tryParse = (s: string) => {
    if (seen.has(s)) return;
    seen.add(s);
    try {
      out.push(JSON.parse(s));
    } catch {
      // not JSON
    }
  };
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) tryParse(trimmed);
  const cleaned = stripReasoning(content);
  const objects = findJsonObjects(cleaned).sort((a, b) => b.length - a.length);
  for (const o of objects) tryParse(o);
  return out;
}
