/**
 * Lines up the passages of a chapter with the passages of its translation,
 * to show a reference pair side by side; nothing is learned from it. It
 * follows Gale and Church's method (lengths in characters), applied to
 * paragraphs, with names and numbers both sides share as extra evidence.
 * Every passage appears in exactly one row, in order on both sides.
 */

export interface PassageRow {
  /** Indexes into the source passages, in order. */
  source: number[];
  /** Indexes into the target passages, in order. */
  target: number[];
}

/** Variance of the target length per source character (Gale and Church). */
const VARIANCE = 6.8;

/** Allowed steps: [source passages, target passages, penalty (−log of how often it happens)]. */
const MOVES: [number, number, number][] = [
  [1, 1, -Math.log(0.89)],
  [1, 0, -Math.log(0.0099 / 2)],
  [0, 1, -Math.log(0.0099 / 2)],
  [2, 1, -Math.log(0.089 / 2)],
  [1, 2, -Math.log(0.089 / 2)],
  [2, 2, -Math.log(0.011)],
  [3, 1, -Math.log(0.005)],
  [1, 3, -Math.log(0.005)],
];
const MAX_STEP = 3;
/** The moves as flat arrays, for the inner loop. */
const DI = Int8Array.from(MOVES.map((m) => m[0]));
const DJ = Int8Array.from(MOVES.map((m) => m[1]));
const PENALTY = Float64Array.from(MOVES.map((m) => m[2]));
/** Most a passage with no counterpart costs for its length. */
const UNMATCHED = 4;

/**
 * Most DP cells computed before falling back to a proportional pairing:
 * about a third of a second, since it runs on the server's main thread.
 */
const MAX_CELLS = 900_000;
/** Most DP cells for which the length ratio is refined with a second pass. */
const MAX_CELLS_REFINED = 300_000;

/** −log of the two-sided tail probability of a standard normal at `x` (x ≥ 0). */
function tailCost(x: number): number {
  if (x < 6) {
    // Abramowitz and Stegun 7.1.26: erfc(z), z = x/√2.
    const z = x / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const poly =
      t *
      (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return -Math.log(Math.max(poly * Math.exp(-z * z), 1e-300));
  }
  // Asymptotic: erfc(z) ≈ e^(−z²) / (z√π).
  return (x * x) / 2 + Math.log(x / Math.SQRT2) + 0.5 * Math.log(Math.PI);
}

function lengthCost(sourceLength: number, targetLength: number, ratio: number): number {
  if (sourceLength + targetLength === 0) return 0;
  const mean = (sourceLength + targetLength / ratio) / 2;
  const delta = (targetLength - sourceLength * ratio) / Math.sqrt(Math.max(mean, 1) * VARIANCE);
  return tailCost(Math.abs(delta));
}

/**
 * Names and numbers in a passage: digits, and capitalized words that don't
 * start a sentence, as their first three letters without accents, so that
 * "Bob", "Boba" and "Bobem" agree.
 */
export function anchorsOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    if (/^\p{N}+$/u.test(word)) {
      out.add(word);
      continue;
    }
    if (!/^\p{Lu}/u.test(word) || word.length < 3) continue;
    const before = text.slice(0, m.index).trimEnd();
    if (before === "" || /[.!?…:"“”«»„–—-]$/.test(before)) continue;
    out.add(word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().slice(0, 3));
  }
  return [...out];
}

/** Lower is better: shared names and numbers make a match likelier, none at all less likely. */
function anchorCost(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared === 0 ? 2 : -2 * Math.min(shared, 3);
}

/** One row per source passage, with the target passages that fall at the same place. */
function proportional(n: number, m: number): PassageRow[] {
  const rows: PassageRow[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const end = i === n - 1 ? m : Math.round(((i + 1) * m) / n);
    const target: number[] = [];
    for (; j < end; j++) target.push(j);
    rows.push({ source: [i], target });
  }
  return rows;
}

interface Side {
  lengths: number[];
  /** Names and numbers per passage. */
  anchors: Set<string>[];
}

function align(source: Side, target: Side, ratio: number, band: number): PassageRow[] | null {
  const n = source.lengths.length;
  const m = target.lengths.length;
  const width = 2 * band + 1;
  // Only cells near the diagonal are computed.
  const lo = (i: number) => Math.max(0, Math.round((i * m) / n) - band);
  const hi = (i: number) => Math.min(m, Math.round((i * m) / n) + band);
  const prefix = (xs: number[]) => {
    const out = [0];
    for (const x of xs) out.push(out[out.length - 1]! + x);
    return out;
  };
  const ps = prefix(source.lengths);
  const pt = prefix(target.lengths);

  // Costs of the last few rows (a step goes back at most MAX_STEP rows), and every step taken.
  const costs = Array.from({ length: MAX_STEP + 1 }, () => new Float64Array(m + 1));
  const steps = new Int8Array((n + 1) * width).fill(-1);
  for (let i = 0; i <= n; i++) {
    const row = costs[i % (MAX_STEP + 1)]!;
    row.fill(Number.POSITIVE_INFINITY);
    const from = lo(i);
    const to = hi(i);
    for (let j = from; j <= to; j++) {
      if (i === 0 && j === 0) {
        row[0] = 0;
        continue;
      }
      let best = Number.POSITIVE_INFINITY;
      let bestMove = -1;
      for (let k = 0; k < DI.length; k++) {
        const di = DI[k]!;
        const dj = DJ[k]!;
        if (di > i || dj > j) continue;
        const before = costs[(i - di) % (MAX_STEP + 1)]![j - dj]!;
        if (before === Number.POSITIVE_INFINITY) continue;
        const length = lengthCost(ps[i]! - ps[i - di]!, pt[j]! - pt[j - dj]!, ratio);
        // A passage with no counterpart costs the same at any length (an
        // added note, a cut paragraph), so it isn't forced into a neighbour.
        let cost =
          before + PENALTY[k]! + (di === 0 || dj === 0 ? Math.min(UNMATCHED, length) : length);
        // Names and numbers settle one-to-one matches between passages of similar length.
        if (di === 1 && dj === 1)
          cost += anchorCost(source.anchors[i - 1]!, target.anchors[j - 1]!);
        if (cost < best) {
          best = cost;
          bestMove = k;
        }
      }
      row[j] = best;
      steps[i * width + (j - from)] = bestMove;
    }
  }

  const rows: PassageRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const k = j >= lo(i) && j <= hi(i) ? steps[i * width + (j - lo(i))]! : -1;
    if (k < 0) return null;
    const di = DI[k]!;
    const dj = DJ[k]!;
    rows.push({
      source: Array.from({ length: di }, (_, x) => i - di + x),
      target: Array.from({ length: dj }, (_, x) => j - dj + x),
    });
    i -= di;
    j -= dj;
  }
  return rows.reverse();
}

const clampRatio = (r: number) => Math.min(5, Math.max(0.2, r));

/** Rows of matching passages, given the passages' plain text. */
export function matchPassages(source: string[], target: string[]): PassageRow[] {
  const n = source.length;
  const m = target.length;
  if (n === 0) return target.map((_, j) => ({ source: [], target: [j] }));
  if (m === 0) return source.map((_, i) => ({ source: [i], target: [] }));

  // Only cells near the diagonal are computed; the band leaves room for
  // stretches with no counterpart.
  const band = Math.max(50, Math.ceil(0.1 * Math.max(n, m)));
  const cells = (n + 1) * (2 * band + 1);
  if (cells > MAX_CELLS) return proportional(n, m);
  const side = (texts: string[]): Side => ({
    lengths: texts.map((t) => t.length),
    anchors: texts.map((t) => new Set(anchorsOf(t))),
  });
  const s = side(source);
  const t = side(target);
  const totalS = s.lengths.reduce((a, x) => a + x, 0);
  const totalT = t.lengths.reduce((a, x) => a + x, 0);
  let ratio = totalS > 0 && totalT > 0 ? clampRatio(totalT / totalS) : 1;

  let rows = align(s, t, ratio, band);
  // A passage with no counterpart skews the overall ratio; the passages
  // matched one to one give a better one.
  if (rows && cells <= MAX_CELLS_REFINED) {
    const ratios = rows
      .filter((r) => r.source.length === 1 && r.target.length === 1)
      .map((r) => [s.lengths[r.source[0]!]!, t.lengths[r.target[0]!]!] as const)
      .filter(([a, b]) => a >= 20 && b >= 20)
      .map(([a, b]) => b / a)
      .sort((a, b) => a - b);
    if (ratios.length >= 5) {
      const median = clampRatio(ratios[Math.floor(ratios.length / 2)]!);
      if (Math.abs(median / ratio - 1) > 0.05) {
        ratio = median;
        rows = align(s, t, ratio, band) ?? rows;
      }
    }
  }
  return rows ?? proportional(n, m);
}
