import { stripPlaceholders, type TransUnit } from "../epub/blocks.ts";
import { tokenize } from "../epub/splice.ts";
import { allLanguageData, languageData } from "../languages/index.ts";
import { languageDisplayName, primarySubtag, scriptShare } from "../shared/languages.ts";

/**
 * Checks for translated units. Errors make the unit unusable (it gets a repair
 * turn or a retry); warnings are shown in review but don't block anything.
 * Nothing here depends on the target language beyond its script.
 */

export interface UnitCheck {
  errors: string[];
  warnings: string[];
}

export interface CheckContext {
  /** Unicode script values of the target language (empty = skip the script check). */
  targetScripts: string[];
  /** Typical translation/source length ratio in graphemes (median). */
  ratio: number;
  /** Checks that depend on the two languages; without them, an English source is assumed. */
  languages?: LanguageChecks;
}

export interface LanguageChecks {
  sourceName: string;
  /** English sources keep the preamble rule they always had. */
  englishSource: boolean;
  /** Common words of the source language that aren't common in the target too. */
  sourceCommon: Set<string>;
  /** Preamble phrases in the target language (besides the English ones). */
  targetPreamble: RegExp | null;
}

const languageChecksMemo = new Map<string, LanguageChecks>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What the checks need to know about a source and target language. */
export function languageChecks(sourceLang: string, targetLang: string): LanguageChecks {
  const key = `${sourceLang}>${targetLang}`;
  let checks = languageChecksMemo.get(key);
  if (!checks) {
    const source = languageData(sourceLang);
    const target = languageData(targetLang);
    const targetCommon = new Set(target?.commonWords ?? []);
    const englishTarget = primarySubtag(targetLang) === "en";
    const phrases = englishTarget ? [] : (target?.preambles ?? []);
    checks = {
      sourceName: languageDisplayName(sourceLang),
      englishSource: primarySubtag(sourceLang) === "en",
      sourceCommon: new Set((source?.commonWords ?? []).filter((w) => !targetCommon.has(w))),
      targetPreamble:
        phrases.length > 0 ? new RegExp(`^(${phrases.map(escapeRegExp).join("|")})`, "iu") : null,
    };
    languageChecksMemo.set(key, checks);
  }
  return checks;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of graphemes.segment(text)) n++;
  return n;
}

const HTML_TAG = /<\/?(i|b|em|strong|span|p|br|div|a|sup|sub|small|u|s)(\s[^>]*)?\/?>/i;
const MALFORMED_PLACEHOLDER = /<\/?[gx]\s*\d*[^>]*$|<\/x\d+>|<x\d+>(?!\s*\/)|<g\d+\s*\/>/i;
const MARKDOWN = /(\*\*[^*\n]+\*\*)|(^|\s)\*[^*\s][^*\n]*\*(?=\s|[.,;:!?]|$)|(^|\s)__[^_\n]+__/;
const PREAMBLE = /^(here is|here's|sure[,!]|translation:|translated text:)/i;
/** The word for "translation" in any language with a file: "translat", "übersetz", "tłumacz" … */
const TRANSLATION_WORD = new RegExp(
  allLanguageData()
    .flatMap((d) => d.translationWords ?? [])
    .map(escapeRegExp)
    .join("|") || "translat",
  "iu",
);
const QUOTES = /^["“”„«»‚‘’「『]/u;

/**
 * Whether an answer that starts like a preamble really is one: it mentions
 * the translation or introduces something with a colon. Used where a phrase
 * like "Sure," could also start a real translation (sources other than
 * English, and preambles in the target language).
 */
function looksLikePreamble(text: string): boolean {
  const first = text.split("\n")[0]!.slice(0, 120);
  return TRANSLATION_WORD.test(first) || /^[^.!?]{0,60}:/u.test(first);
}

const WORDS = /\p{L}+/gu;

/**
 * Whether a translation is still largely in the source language: it uses the
 * source's common words at least half as much as the source does.
 */
function soundsLikeSource(source: string, text: string, common: Set<string>): boolean {
  const words = text.toLowerCase().match(WORDS) ?? [];
  if (words.length < 8) return false;
  const hits = words.filter((w) => common.has(w));
  if (new Set(hits).size < 3) return false;
  const sourceWords = source.toLowerCase().match(WORDS) ?? [];
  const sourceShare = sourceWords.filter((w) => common.has(w)).length / sourceWords.length;
  return sourceShare >= 0.15 && hits.length / words.length >= sourceShare / 2;
}
const QUOTES_END = /["“”„«»‚‘’」』]$/u;

export function checkUnitTranslation(unit: TransUnit, text: string, ctx: CheckContext): UnitCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const source = stripPlaceholders(unit.text);
  const plain = stripPlaceholders(text);

  if (!plain.trim() && /\p{L}/u.test(source)) errors.push("the translation is empty");

  // Placeholders: known numbers, counts, nesting.
  const byN = new Map(unit.placeholders.map((p) => [p.n, p]));
  const opens = new Map<number, number>();
  const closes = new Map<number, number>();
  const xs = new Map<number, number>();
  const stack: number[] = [];
  let nestingError = false;
  for (const token of tokenize(text)) {
    if (token.t === "text") continue;
    const p = byN.get(token.n);
    if (!p) {
      errors.push(`unknown placeholder ${token.t === "x" ? `<x${token.n}/>` : `<g${token.n}>`}`);
      continue;
    }
    if (token.t === "x") {
      if (p.kind !== "x")
        errors.push(
          `<g${token.n}> must be a pair <g${token.n}>…</g${token.n}>, not <x${token.n}/>`,
        );
      xs.set(token.n, (xs.get(token.n) ?? 0) + 1);
    } else if (token.t === "open") {
      if (p.kind !== "g") errors.push(`<x${token.n}/> must stay self-closing`);
      opens.set(token.n, (opens.get(token.n) ?? 0) + 1);
      stack.push(token.n);
    } else {
      closes.set(token.n, (closes.get(token.n) ?? 0) + 1);
      if (stack[stack.length - 1] === token.n) stack.pop();
      else nestingError = true;
    }
  }
  if (stack.length > 0 || nestingError)
    errors.push("placeholders aren't properly nested or closed");
  for (const p of unit.placeholders) {
    if (p.kind === "x") {
      const count = xs.get(p.n) ?? 0;
      if (count !== 1) errors.push(`<x${p.n}/> must appear exactly once (found ${count})`);
    } else {
      const o = opens.get(p.n) ?? 0;
      const c = closes.get(p.n) ?? 0;
      if (o !== c) errors.push(`<g${p.n}> and </g${p.n}> don't match`);
      else if (p.required && o !== 1)
        errors.push(`<g${p.n}>…</g${p.n}> must appear exactly once (found ${o})`);
    }
  }
  if (MALFORMED_PLACEHOLDER.test(text.replace(/<\/?g\d+>|<x\d+\/>/g, "")))
    errors.push("contains a malformed placeholder");

  // Model artifacts.
  if (HTML_TAG.test(plain) && !HTML_TAG.test(source))
    errors.push("contains HTML tags; use the placeholders instead");
  if (MARKDOWN.test(plain) && !MARKDOWN.test(source)) errors.push("contains Markdown formatting");
  const lc = ctx.languages;
  const englishPreamble =
    PREAMBLE.test(plain.trim()) &&
    !PREAMBLE.test(source.trim()) &&
    (!lc || lc.englishSource || looksLikePreamble(plain.trim()));
  const targetPreamble =
    !!lc?.targetPreamble &&
    lc.targetPreamble.test(plain.trim()) &&
    !lc.targetPreamble.test(source.trim()) &&
    looksLikePreamble(plain.trim());
  if (englishPreamble || targetPreamble)
    errors.push("starts with a preamble instead of the translation");
  const t = plain.trim();
  const s = source.trim();
  if (
    t.length > 2 &&
    QUOTES.test(t) &&
    QUOTES_END.test(t) &&
    !QUOTES.test(s) &&
    !QUOTES_END.test(s)
  ) {
    errors.push("is wrapped in quotation marks that aren't in the source");
  }

  // Warnings.
  const sourceLen = graphemeCount(s);
  const targetLen = graphemeCount(t);
  if (sourceLen >= 20 && targetLen > 0) {
    const ratio = targetLen / sourceLen;
    const wide = sourceLen < 60 ? 2 : 1;
    const lo = ctx.ratio / (3 * wide);
    const hi = ctx.ratio * 3 * wide;
    if (ratio < lo)
      warnings.push(`much shorter than the source (${Math.round(ratio * 100)}% of its length)`);
    if (ratio > hi)
      warnings.push(`much longer than the source (${Math.round(ratio * 100)}% of its length)`);
  }
  if (t === s && s.split(/\s+/).length >= 6 && !/^(https?:|www\.)\S+$/.test(s))
    warnings.push("identical to the source (untranslated?)");
  if (ctx.targetScripts.length > 0 && (s.match(/\p{L}/gu)?.length ?? 0) >= 20) {
    const share = scriptShare(t, ctx.targetScripts);
    if (share !== null && share < 0.5) warnings.push("mostly not in the target language's script");
  }
  if (
    lc &&
    lc.sourceCommon.size > 0 &&
    warnings.every((w) => !w.startsWith("identical") && !w.startsWith("mostly not")) &&
    soundsLikeSource(s, t, lc.sourceCommon)
  )
    warnings.push(`may still be partly in ${lc.sourceName}`);
  return { errors, warnings };
}

export interface ChunkCheck {
  /** Problems to send back to the model (errors only). */
  problems: string[];
  perUnit: Map<string, UnitCheck>;
  missing: string[];
}

/** Checks a chunk answer: every id once, in the request, plus per-unit checks. */
export function checkChunk(
  requested: { id: string; unit: TransUnit }[],
  outputs: { id: string; text: string }[],
  ctx: CheckContext,
): ChunkCheck {
  const problems: string[] = [];
  const perUnit = new Map<string, UnitCheck>();
  const wanted = new Map(requested.map((r) => [r.id, r.unit]));
  const seen = new Map<string, number>();
  for (const o of outputs) seen.set(o.id, (seen.get(o.id) ?? 0) + 1);
  for (const [id, count] of seen) {
    if (!wanted.has(id)) problems.push(`unit ${id} wasn't requested; return only the given ids`);
    else if (count > 1) problems.push(`unit ${id} appears ${count} times; return it once`);
  }
  const missing = requested.filter((r) => !seen.has(r.id)).map((r) => r.id);
  for (const id of missing) problems.push(`unit ${id} is missing`);
  for (const o of outputs) {
    const unit = wanted.get(o.id);
    if (!unit || perUnit.has(o.id)) continue;
    const check = checkUnitTranslation(unit, o.text, ctx);
    perUnit.set(o.id, check);
    for (const e of check.errors) problems.push(`unit ${o.id}: ${e}`);
  }
  // Shifted outputs: neighbours with identical text.
  for (let i = 1; i < outputs.length; i++) {
    const a = outputs[i - 1]!;
    const b = outputs[i]!;
    if (a.text.trim() && a.text === b.text && wanted.get(a.id)?.text !== wanted.get(b.id)?.text) {
      perUnit.get(b.id)?.warnings.push(`same text as unit ${a.id} (shifted?)`);
    }
  }
  return { problems, perUnit, missing };
}
