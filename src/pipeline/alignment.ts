import { type LanguageData, languageData } from "../languages/index.ts";
import type { Alignment, AlignUnit } from "../shared/schemas/alignment.ts";
import type { Segment } from "../shared/schemas/epub.ts";

/**
 * Automatic chapter alignment, like Gale–Church sentence alignment applied
 * to chapters: a dynamic program over the two segment lists with moves
 * 1–1, 1–0, 0–1, 2–1 and 1–2, scored by length agreement (after correcting
 * for the overall length ratio) plus a bonus for matching numbers or names
 * in the titles. You review and fix the result in the UI.
 */

const ROMAN = /\b(?=[MDCLXVI])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})\b/;

function romanToInt(s: string): number {
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = map[s[i]!] ?? 0;
    const next = map[s[i + 1]!] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}

/**
 * Numbers in a title: Arabic digits and Roman numerals, or, when there are
 * none and the title's language is known, number words ("Chapter One",
 * "Rozdział pierwszy", "Erstes Kapitel").
 */
export function titleNumbers(title: string, lang?: string): number[] {
  const out: number[] = [];
  for (const m of title.matchAll(/\d+/g)) out.push(Number(m[0]));
  for (const word of title.split(/[^A-Za-z]+/)) {
    if (
      word.length > 0 &&
      word.length <= 8 &&
      word === word.toUpperCase() &&
      ROMAN.test(word) &&
      word.match(ROMAN)?.[0] === word
    ) {
      const n = romanToInt(word);
      if (n > 0) out.push(n);
    }
  }
  if (out.length > 0 || !lang) return out;
  const data = languageData(lang);
  return data ? numberWordsIn(title, data) : out;
}

/** A number word, or an ordinal (its stem plus up to three letters of ending). */
function numberWord(word: string, data: LanguageData): number | null {
  const cardinal = data.numberWords?.[word];
  if (cardinal !== undefined) return cardinal;
  let best: number | null = null;
  let bestLength = 0;
  for (const [stem, n] of Object.entries(data.ordinals ?? {})) {
    if (word.startsWith(stem) && word.length - stem.length <= 3 && stem.length > bestLength) {
      best = n;
      bestLength = stem.length;
    }
  }
  return best;
}

/**
 * Number words that stand next to a chapter word ("Part Two", "Erstes
 * Kapitel") or make up the whole title ("Twenty-One"). Compounds add up:
 * "twenty one" and "dwudziesty pierwszy" are 21.
 */
function numberWordsIn(title: string, data: LanguageData): number[] {
  const words = title.toLowerCase().match(/\p{L}+/gu) ?? [];
  const values = words.map((w) => numberWord(w, data));
  const chapter = new Set(data.chapterWords ?? []);
  const out: number[] = [];
  for (let i = 0; i < words.length; ) {
    if (values[i] === null) {
      i++;
      continue;
    }
    let j = i;
    const run: number[] = [];
    while (j < words.length && values[j] !== null) run.push(values[j++]!);
    const whole = i === 0 && j === words.length;
    if (whole || chapter.has(words[i - 1] ?? "") || chapter.has(words[j] ?? "")) {
      const numbers: number[] = [];
      for (const n of run) {
        const tens = numbers[numbers.length - 1];
        if (tens !== undefined && tens >= 20 && tens % 10 === 0 && n < 10)
          numbers[numbers.length - 1] = tens + n;
        else numbers.push(n);
      }
      out.push(...numbers);
    }
    i = j;
  }
  return out;
}

function properNames(title: string): Set<string> {
  return new Set((title.match(/\p{Lu}\p{L}{2,}/gu) ?? []).map((w) => w.toLowerCase()));
}

function titleBonus(a: Segment[], b: Segment[], languages?: TitleLanguages): number {
  const ta = a.map((s) => s.title).join(" ");
  const tb = b.map((s) => s.title).join(" ");
  const na = titleNumbers(ta, languages?.source);
  const nb = titleNumbers(tb, languages?.target);
  if (na.length > 0 && nb.length > 0 && na.some((n) => nb.includes(n))) return 1.2;
  const pa = properNames(ta);
  const pb = properNames(tb);
  for (const name of pa) if (pb.has(name) && name.length > 3) return 0.6;
  return 0;
}

const words = (list: Segment[]) => list.reduce((s, x) => s + x.words, 0);

function lengthCost(wa: number, wb: number, ratio: number): number {
  return Math.abs(Math.log((wb / ratio + 20) / (wa + 20))) * 2.2;
}

/**
 * Leaving a segment out. Grows slowly with length, so a chapter that only one
 * book has (an extra story, a licence) is skipped instead of forcing every
 * later chapter out of step.
 */
function skipCost(w: number): number {
  return w < 150 ? 0.4 : 1.2 + 0.5 * Math.log2(w / 150);
}

/**
 * Matching body text with front or back matter, or joining the two into one
 * unit, is unlikely but possible (the guesses can be wrong).
 */
function guessPenalty(a: Segment[], b: Segment[]): number {
  const isBody = (s: Segment) => s.guess === "body";
  const kind = (list: Segment[]) => (list.some(isBody) ? "body" : "other");
  const mixed = (list: Segment[]) => list.some(isBody) && !list.every(isBody);
  return (kind(a) === kind(b) ? 0 : 1.5) + (mixed(a) || mixed(b) ? 1.5 : 0);
}

/** Languages of the two books, for reading number words in titles. */
export interface TitleLanguages {
  source: string;
  target: string;
}

export interface ProposalOptions {
  /** Units are included by default only when both sides look like body text. */
  minWords?: number;
  languages?: TitleLanguages;
}

/**
 * Overall length ratio (target words per source word), from the larger body
 * segments, so a licence or notes that only one book has don't skew it.
 */
export function lengthRatio(source: Segment[], target: Segment[]): number {
  const big = (list: Segment[], body: boolean) =>
    list
      .filter((s) => s.words >= 300 && (!body || s.guess === "body"))
      .reduce((sum, x) => sum + x.words, 0);
  for (const body of [true, false]) {
    const sa = big(source, body);
    const sb = big(target, body);
    if (sa > 0 && sb > 0) return sb / sa;
  }
  const ta = words(source);
  const tb = words(target);
  return ta > 0 && tb > 0 ? tb / ta : 1;
}

interface DpResult {
  steps: [Segment[], Segment[]][];
  cost: number;
}

function align(
  source: Segment[],
  target: Segment[],
  ratio: number,
  languages?: TitleLanguages,
): DpResult {
  const n = source.length;
  const m = target.length;
  const INF = Number.POSITIVE_INFINITY;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF));
  const back: [number, number][][] = Array.from({ length: n + 1 }, () =>
    new Array<[number, number]>(m + 1).fill([0, 0]),
  );
  cost[0]![0] = 0;
  const moves: [number, number, number][] = [
    [1, 1, 0],
    [1, 0, 0],
    [0, 1, 0],
    [2, 1, 0.35],
    [1, 2, 0.35],
  ];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i]![j]!;
      if (here === INF) continue;
      for (const [di, dj, penalty] of moves) {
        const ni = i + di;
        const nj = j + dj;
        if (ni > n || nj > m) continue;
        const a = source.slice(i, ni);
        const b = target.slice(j, nj);
        let c: number;
        if (di === 0) c = skipCost(words(b) / ratio);
        else if (dj === 0) c = skipCost(words(a));
        else
          c =
            lengthCost(words(a), words(b), ratio) +
            penalty +
            guessPenalty(a, b) -
            titleBonus(a, b, languages);
        if (here + c < cost[ni]![nj]!) {
          cost[ni]![nj] = here + c;
          back[ni]![nj] = [di, dj];
        }
      }
    }
  }
  const steps: [Segment[], Segment[]][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const [di, dj] = back[i]![j]!;
    if (di === 0 && dj === 0) break;
    steps.push([source.slice(i - di, i), target.slice(j - dj, j)]);
    i -= di;
    j -= dj;
  }
  steps.reverse();
  return { steps, cost: cost[n]![m]! };
}

/** Median length ratio of the substantial chapters an alignment matched. */
function matchedRatio(steps: [Segment[], Segment[]][]): number | null {
  const ratios = steps
    .filter(([a, b]) => words(a) >= 300 && words(b) >= 300)
    .map(([a, b]) => words(b) / words(a))
    .sort((x, y) => x - y);
  if (ratios.length === 0) return null;
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
}

/**
 * Aligns with the overall ratio, then refines the ratio from the substantial
 * chapters that matched and aligns again until it settles.
 */
function bestAlignment(
  source: Segment[],
  target: Segment[],
  languages?: TitleLanguages,
): DpResult & { ratio: number } {
  let ratio = lengthRatio(source, target);
  let result = align(source, target, ratio, languages);
  for (let k = 0; k < 5; k++) {
    const next = matchedRatio(result.steps);
    if (next === null || Math.abs(Math.log(next / ratio)) < 0.01) break;
    ratio = next;
    result = align(source, target, ratio, languages);
  }
  return { ...result, ratio };
}

export function proposeAlignment(
  source: Segment[],
  target: Segment[],
  depths: { source: number; target: number },
  options: ProposalOptions = {},
): Alignment {
  const { steps, ratio } = bestAlignment(source, target, options.languages);
  const units = steps.map(([a, b]) =>
    makeUnit(a, b, ratio, options.minWords ?? 150, options.languages),
  );
  return {
    schemaVersion: 1,
    status: "proposed",
    tocDepthSource: depths.source,
    tocDepthTarget: depths.target,
    units: units.map((u, k) => ({ ...u, id: `a${k}` })),
  };
}

/**
 * Length ratio implied by an alignment: the median over its included units,
 * falling back to the overall ratio when nothing substantial is matched yet.
 */
export function alignmentRatio(alignment: Alignment, source: Segment[], target: Segment[]): number {
  const byId = (list: Segment[]) => new Map(list.map((s) => [s.id, s]));
  const sa = byId(source);
  const sb = byId(target);
  const steps: [Segment[], Segment[]][] = alignment.units
    .filter((u) => u.include)
    .map((u) => [
      u.source.flatMap((id) => sa.get(id) ?? []),
      u.target.flatMap((id) => sb.get(id) ?? []),
    ]);
  return matchedRatio(steps) ?? lengthRatio(source, target);
}

function makeUnit(
  a: Segment[],
  b: Segment[],
  ratio: number,
  minWords: number,
  languages?: TitleLanguages,
): AlignUnit {
  const wa = words(a);
  const wb = words(b);
  let confidence: number;
  if (a.length === 0 || b.length === 0) confidence = 0.5;
  else {
    const lc = lengthCost(wa, wb, ratio) - titleBonus(a, b, languages) * 0.5;
    confidence = Math.max(0, Math.min(1, 1 - lc / 2));
  }
  const looksLikeBody = (list: Segment[], w: number) =>
    list.some((s) => s.guess === "body") && w >= minWords;
  return {
    id: "",
    source: a.map((s) => s.id),
    target: b.map((s) => s.id),
    include: looksLikeBody(a, wa) && looksLikeBody(b, wb / Math.max(ratio, 0.01)),
    confidence: Math.round(confidence * 100) / 100,
  };
}

/** Checks an edited alignment against the segment lists. Returns problems (empty = OK). */
export function checkAlignment(
  alignment: Alignment,
  source: Segment[],
  target: Segment[],
): string[] {
  const problems: string[] = [];
  const check = (ids: string[], list: Segment[], side: string) => {
    const known = new Map(list.map((s, i) => [s.id, i]));
    let last = -1;
    const seen = new Set<string>();
    for (const id of ids) {
      const idx = known.get(id);
      if (idx === undefined) {
        problems.push(`unknown ${side} segment ${id}`);
        continue;
      }
      if (seen.has(id)) problems.push(`${side} segment ${id} is used twice`);
      seen.add(id);
      if (idx < last) problems.push(`${side} segments must stay in book order`);
      last = idx;
    }
  };
  check(
    alignment.units.flatMap((u) => u.source),
    source,
    "source",
  );
  check(
    alignment.units.flatMap((u) => u.target),
    target,
    "target",
  );
  return problems;
}

/** Prompt ids for the AI proposal: S1… for the original segments, T1… for translated ones. */
function promptIdIndex(prefix: string, count: number): Map<string, number> {
  return new Map(Array.from({ length: count }, (_, i) => [`${prefix}${i + 1}`, i]));
}

interface AiUnit {
  source: string[];
  target: string[];
  include: boolean;
}

/** Problems in an AI-proposed alignment, phrased for a repair turn (empty = OK). */
export function aiAlignmentProblems(units: AiUnit[], sourceCount: number, targetCount: number) {
  const problems: string[] = [];
  const side = (key: "source" | "target", prefix: string, count: number) => {
    const known = promptIdIndex(prefix, count);
    const seen = new Set<string>();
    let last = -1;
    for (const unit of units) {
      for (const id of unit[key]) {
        const idx = known.get(id);
        if (idx === undefined) problems.push(`Unknown id ${id}.`);
        else if (seen.has(id)) problems.push(`${id} is used more than once.`);
        else {
          if (idx < last) problems.push(`${id} is out of book order.`);
          last = idx;
        }
        seen.add(id);
      }
    }
    const missing = [...known.keys()].filter((id) => !seen.has(id));
    if (missing.length > 0)
      problems.push(
        `These ids are missing (give each a unit, with an empty list on the other side if unmatched): ${missing.join(", ")}.`,
      );
  };
  side("source", "S", sourceCount);
  side("target", "T", targetCount);
  if (units.some((u) => u.source.length === 0 && u.target.length === 0))
    problems.push("A unit has no ids on either side.");
  return problems;
}

/** Turns a checked AI proposal into an alignment. */
export function fromAiAlignment(
  units: AiUnit[],
  source: Segment[],
  target: Segment[],
  depths: { source: number; target: number },
): Alignment {
  const toIds = (ids: string[], prefix: string, list: Segment[]) =>
    ids.map((id) => list[Number(id.slice(prefix.length)) - 1]!.id);
  return {
    schemaVersion: 1,
    status: "proposed",
    tocDepthSource: depths.source,
    tocDepthTarget: depths.target,
    units: units.map((u, k) => ({
      id: `a${k}`,
      source: toIds(u.source, "S", source),
      target: toIds(u.target, "T", target),
      include: u.include && u.source.length > 0 && u.target.length > 0,
      confidence: null,
    })),
  };
}
