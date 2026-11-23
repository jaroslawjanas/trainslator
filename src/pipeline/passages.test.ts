import { describe, expect, it } from "vitest";
import { anchorsOf, matchPassages, type PassageRow } from "./passages.ts";

/** Every passage appears once, in order, on both sides. */
function expectComplete(rows: PassageRow[], n: number, m: number) {
  expect(rows.flatMap((r) => r.source)).toEqual(Array.from({ length: n }, (_, i) => i));
  expect(rows.flatMap((r) => r.target)).toEqual(Array.from({ length: m }, (_, i) => i));
  for (const r of rows) expect(r.source.length + r.target.length).toBeGreaterThan(0);
}

/** Filler text of a given length. */
const text = (length: number, seed = 0) =>
  Array.from({ length }, (_, i) => "abcdefghij klmnop qrstu vwxyz"[(i + seed) % 29]).join("");

/** Passages of varied length, and a translation 10% longer with some noise. */
function chapter(count: number) {
  const lengths = Array.from({ length: count }, (_, i) => 80 + ((i * 37) % 300));
  const source = lengths.map((l, i) => text(l, i));
  const target = lengths.map((l, i) => text(Math.round(l * (1.1 + (((i * 7) % 10) - 5) / 50)), i));
  return { source, target };
}

const oneToOne = (rows: PassageRow[]) =>
  rows.filter((r) => r.source.length === 1 && r.target.length === 1).length;

describe("matchPassages", () => {
  it("pairs passages one to one when the lengths agree", () => {
    const { source, target } = chapter(30);
    expect(matchPassages(source, target)).toEqual(
      source.map((_, i) => ({ source: [i], target: [i] })),
    );
  });

  it("joins a passage the translator split in two", () => {
    const source = [text(100), text(400), text(90)];
    const target = [text(105), text(190), text(220), text(95)];
    expect(matchPassages(source, target)).toEqual([
      { source: [0], target: [0] },
      { source: [1], target: [1, 2] },
      { source: [2], target: [3] },
    ]);
  });

  it("gives a passage with no counterpart a row of its own and keeps the rest in step", () => {
    const { source, target } = chapter(40);
    for (const extra of [150, 400, 2000]) {
      const withExtra = [...source.slice(0, 20), text(extra), ...source.slice(20)];
      const rows = matchPassages(withExtra, target);
      expectComplete(rows, 41, 40);
      expect(rows).toContainEqual({ source: [20], target: [] });
      expect(oneToOne(rows)).toBe(40);
    }
  });

  it("uses shared names to stay in step where every passage is as long", () => {
    const names =
      "Bob Bill Howard Riker Garfield Bridget Hugh Will Marcus Claude Herschel Jacques Mario Linus Khan Calvin Goku Luke Neil Homer".split(
        " ",
      );
    const source = names.map((n, i) => `${text(40, i)} ${n} ${text(60, i)}`);
    // The translation leaves out passage 10.
    const kept = names.filter((_, i) => i !== 10);
    const target = kept.map((n, i) => `${text(46, i)} ${n} ${text(64, i)}`);
    const rows = matchPassages(source, target);
    expectComplete(rows, 20, 19);
    expect(oneToOne(rows)).toBeGreaterThanOrEqual(18);
    for (const r of rows)
      if (r.source.length === 1 && r.target.length === 1)
        expect(kept[r.target[0]!]).toBe(names[r.source[0]!]);
  });

  it("handles one empty side", () => {
    expect(matchPassages([], ["a", "b"])).toEqual([
      { source: [], target: [0] },
      { source: [], target: [1] },
    ]);
    expect(matchPassages(["a"], [])).toEqual([{ source: [0], target: [] }]);
    expect(matchPassages([], [])).toEqual([]);
  });

  it("covers every passage when the sides differ a lot", () => {
    // A book converted from a PDF: one passage per printed line.
    const source = Array.from({ length: 260 }, (_, i) => text(60 + ((i * 7) % 15), i));
    const target = Array.from({ length: 60 }, (_, i) => text(250 + ((i * 13) % 90), i));
    expectComplete(matchPassages(source, target), 260, 60);
  });

  it("stays within bounds on very long rows", () => {
    const source = Array.from({ length: 4000 }, (_, i) => text(50 + ((i * 31) % 200), i));
    const target = source.map((x, i) => (i % 50 === 0 ? "" : x));
    expectComplete(matchPassages(source, target), 4000, 4000);
  });
});

describe("anchorsOf", () => {
  it("keeps names and numbers, not words that start a sentence", () => {
    expect(anchorsOf("The ship left. Then Bob met Jacques in 2331.")).toEqual([
      "bob",
      "jac",
      "2331",
    ]);
    expect(anchorsOf("„Wtedy Boba spotkał Żaneta”, powiedział Józef.")).toEqual([
      "bob",
      "zan",
      "joz",
    ]);
  });
});
