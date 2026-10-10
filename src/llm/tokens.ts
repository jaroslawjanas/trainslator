/**
 * Token estimates from character counts, per script, corrected per model from
 * real usage. Used for chunk sizes, pre-flight checks and cost estimates.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN_OR_ASCII = /[\p{Script=Latin}\p{ASCII}]/u;

/** Characters per token by script (rough defaults). */
const CHARS_PER_TOKEN = { latin: 3.8, cyrillic: 3, cjk: 1.2, other: 2.5 };

export function estimateTokens(text: string, factor = 1): number {
  if (!text) return 0;
  let latin = 0;
  let cyrillic = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (LATIN_OR_ASCII.test(ch)) latin++;
    else if (CJK.test(ch)) cjk++;
    else if (CYRILLIC.test(ch)) cyrillic++;
    else other++;
  }
  const tokens =
    latin / CHARS_PER_TOKEN.latin +
    cyrillic / CHARS_PER_TOKEN.cyrillic +
    cjk / CHARS_PER_TOKEN.cjk +
    other / CHARS_PER_TOKEN.other;
  return Math.ceil(tokens * factor);
}

const DEFAULT_ALLOWANCE: Record<string, number> = {
  none: 0,
  minimal: 1000,
  low: 2000,
  medium: 8000,
  high: 16000,
  xhigh: 32000,
  max: 32000,
};

/** 95th percentile of a list (null when empty). */
export function percentile95(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

/**
 * Tokens to reserve for reasoning on top of the answer. Uses observed usage
 * when there are enough samples, otherwise defaults by effort.
 */
export function reasoningAllowance(options: {
  enabled: boolean;
  effort: string | null;
  budgetTokens: number | null;
  mode: "optional" | "on_by_default" | "mandatory";
  samples: number[];
}): number {
  const reasons = options.enabled || options.mode !== "optional";
  if (!reasons) return 0;
  if (options.budgetTokens) return options.budgetTokens;
  const observed = options.samples.length >= 5 ? percentile95(options.samples) : null;
  const effort = (options.effort ?? "medium").toLowerCase();
  const fallback = DEFAULT_ALLOWANCE[effort] ?? DEFAULT_ALLOWANCE.medium!;
  if (observed === null) return fallback;
  return Math.max(512, Math.ceil(observed * 1.2));
}
