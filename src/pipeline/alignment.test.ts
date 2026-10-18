import { describe, expect, it } from "vitest";
import type { Segment } from "../shared/schemas/epub.ts";
import {
  aiAlignmentProblems,
  alignmentRatio,
  checkAlignment,
  fromAiAlignment,
  identityAlignment,
  proposeAlignment,
  titleNumbers,
} from "./alignment.ts";

function seg(id: string, title: string, words: number, guess: Segment["guess"] = "body"): Segment {
  return {
    id,
    index: 0,
    title,
    depth: 1,
    linear: true,
    ranges: [],
    words,
    preview: { start: "", end: "" },
    guess,
  };
}

describe("alignment proposal", () => {
  it("reads Arabic and Roman numbers in titles", () => {
    expect(titleNumbers("CHAPTER IV. The Rabbit")).toEqual([4]);
    expect(titleNumbers("Rozdział 12")).toEqual([12]);
    expect(titleNumbers("I Was There")).toEqual([1]);
  });

  it("reads number words next to a chapter word or as the whole title", () => {
    expect(titleNumbers("Chapter One", "en")).toEqual([1]);
    expect(titleNumbers("Part Two: The Storm", "en")).toEqual([2]);
    expect(titleNumbers("Twenty-One", "en")).toEqual([21]);
    expect(titleNumbers("Chapter Twenty-First", "en")).toEqual([21]);
    expect(titleNumbers("Erstes Kapitel", "de")).toEqual([1]);
    expect(titleNumbers("Kapitel zwölf", "de")).toEqual([12]);
    expect(titleNumbers("Rozdział pierwszy", "pl")).toEqual([1]);
    expect(titleNumbers("Część druga", "pl")).toEqual([2]);
    expect(titleNumbers("Rozdział dwudziesty pierwszy", "pl")).toEqual([21]);
    expect(titleNumbers("Dwadzieścia jeden", "pl")).toEqual([21]);
  });

  it("ignores number words that aren't a chapter number", () => {
    expect(titleNumbers("The First Day", "en")).toEqual([]);
    expect(titleNumbers("One Last Night", "en")).toEqual([]);
    expect(titleNumbers("Die erstaunliche Reise", "de")).toEqual([]);
    expect(titleNumbers("Chapter One", "fr")).toEqual([]);
    // Digits and Roman numerals win; without a language only they count.
    expect(titleNumbers("Chapter One (7)", "en")).toEqual([7]);
    expect(titleNumbers("Chapter One")).toEqual([]);
  });

  it("matches chapters by number words across languages", () => {
    const a = [
      seg("a0", "Chapter One", 3000),
      seg("a1", "Chapter Two", 3000),
      seg("a2", "Chapter Three", 3000),
    ];
    const b = [
      seg("b0", "Rozdział pierwszy", 2000),
      seg("b1", "Rozdział drugi", 3000),
      seg("b2", "Rozdział trzeci", 3000),
    ];
    const languages = { source: "en", target: "pl" };
    const al = proposeAlignment(a, b, { source: 1, target: 1 }, { languages });
    expect(al.units.map((u) => [u.source, u.target])).toEqual([
      [["a0"], ["b0"]],
      [["a1"], ["b1"]],
      [["a2"], ["b2"]],
    ]);
    // The matching numbers make the pairing more certain than lengths alone.
    const plain = proposeAlignment(a, b, { source: 1, target: 1 });
    expect(al.units[0]!.confidence!).toBeGreaterThan(plain.units[0]!.confidence!);
  });

  it("pairs chapters one to one when lengths agree", () => {
    const a = [
      seg("a0", "Chapter 1", 3000),
      seg("a1", "Chapter 2", 4000),
      seg("a2", "Chapter 3", 2500),
    ];
    const b = [
      seg("b0", "Rozdział 1", 2700),
      seg("b1", "Rozdział 2", 3700),
      seg("b2", "Rozdział 3", 2300),
    ];
    const al = proposeAlignment(a, b, { source: 1, target: 1 });
    expect(al.units.map((u) => [u.source, u.target])).toEqual([
      [["a0"], ["b0"]],
      [["a1"], ["b1"]],
      [["a2"], ["b2"]],
    ]);
    expect(al.units.every((u) => u.include)).toBe(true);
  });

  it("skips front matter that only one side has and joins a split chapter", () => {
    const a = [seg("a0", "Copyright", 80, "front"), seg("a1", "One", 3000), seg("a2", "Two", 4000)];
    const b = [seg("b0", "Jeden", 1500), seg("b1", "Jeden (cd.)", 1400), seg("b2", "Dwa", 3900)];
    const al = proposeAlignment(a, b, { source: 1, target: 1 });
    expect(al.units.map((u) => [u.source, u.target, u.include])).toEqual([
      [["a0"], [], false],
      [["a1"], ["b0", "b1"], true],
      [["a2"], ["b2"], true],
    ]);
  });

  it("validates edited alignments", () => {
    const a = [seg("a0", "One", 100), seg("a1", "Two", 100)];
    const b = [seg("b0", "Jeden", 100)];
    const ok = proposeAlignment(a, b, { source: 1, target: 1 });
    expect(checkAlignment(ok, a, b)).toEqual([]);
    const bad = {
      ...ok,
      units: [
        { id: "x", source: ["a1", "a0"], target: ["b0", "b0"], include: true, confidence: null },
      ],
    };
    expect(checkAlignment(bad, a, b).length).toBeGreaterThan(0);
  });

  it("finds the length ratio from matched chapters when one book has extra back matter", () => {
    // A long licence only in the English book would skew the overall ratio.
    const a = [
      seg("a0", "One", 3000),
      seg("a1", "Two", 4000),
      seg("a2", "Three", 2000),
      seg("a3", "Licence", 9000, "back"),
    ];
    const b = [seg("b0", "Jeden", 2200), seg("b1", "Dwa", 3000), seg("b2", "Trzy", 1500)];
    const al = proposeAlignment(a, b, { source: 1, target: 1 });
    expect(al.units.map((u) => [u.source, u.target, u.include])).toEqual([
      [["a0"], ["b0"], true],
      [["a1"], ["b1"], true],
      [["a2"], ["b2"], true],
      [["a3"], [], false],
    ]);
    expect(alignmentRatio(al, a, b)).toBeCloseTo(0.75, 2);
  });

  it("never includes front or back matter by default", () => {
    const a = [seg("a0", "Story", 3000), seg("a1", "Licence", 2500, "back")];
    const b = [seg("b0", "Opowieść", 2300), seg("b1", "Nota", 2000, "back")];
    const al = proposeAlignment(a, b, { source: 1, target: 1 });
    expect(al.units.map((u) => u.include)).toEqual([true, false]);
  });

  it("checks and converts an AI proposal", () => {
    const a = [seg("a0", "Front", 50, "front"), seg("a1", "Story", 3000)];
    const b = [seg("b0", "Opowieść", 2300), seg("b1", "Inna", 4000), seg("b2", "Nota", 90)];
    const good = [
      { source: ["S1"], target: [], include: false },
      { source: ["S2"], target: ["T1"], include: true },
      { source: [], target: ["T2"], include: true },
      { source: [], target: ["T3"], include: false },
    ];
    expect(aiAlignmentProblems(good, 2, 3)).toEqual([]);
    const al = fromAiAlignment(good, a, b, { source: 1, target: 1 });
    expect(al.units.map((u) => [u.source, u.target, u.include])).toEqual([
      [["a0"], [], false],
      [["a1"], ["b0"], true],
      [[], ["b1"], false],
      [[], ["b2"], false],
    ]);
    expect(checkAlignment(al, a, b)).toEqual([]);

    const bad = [
      { source: ["S2", "S1"], target: ["T1", "T1"], include: true },
      { source: ["S9"], target: [], include: false },
      { source: [], target: [], include: false },
    ];
    const problems = aiAlignmentProblems(bad, 2, 3).join(" ");
    expect(problems).toContain("S1 is out of book order");
    expect(problems).toContain("T1 is used more than once");
    expect(problems).toContain("Unknown id S9");
    expect(problems).toContain("missing");
    expect(problems).toContain("T2, T3");
    expect(problems).toContain("no ids on either side");
  });
});

describe("identity alignment (a book and its own build)", () => {
  const inDoc = (s: Segment, docIndex: number): Segment => ({
    ...s,
    ranges: [{ docIndex, fromUnit: 0, toUnit: 5 }],
  });
  const source = [
    inDoc(seg("d1s0", "Contents", 40, "front"), 0),
    inDoc(seg("d1s1", "Chapter One", 3000), 1),
    inDoc(seg("d1s2", "Chapter Two", 3000), 2),
  ];
  const target = source.map((s) => ({ ...s, title: `T: ${s.title}`, words: s.words - 200 }));

  it("matches every chapter with the one of the same id, confirmed", () => {
    const a = identityAlignment(source, target, 1)!;
    expect(a).toMatchObject({ status: "confirmed", tocDepthSource: 1, tocDepthTarget: 1 });
    expect(a.units.map((u) => [u.id, u.source, u.target, u.include, u.confidence])).toEqual([
      ["a0", ["d1s0"], ["d1s0"], false, 1],
      ["a1", ["d1s1"], ["d1s1"], true, 1],
      ["a2", ["d1s2"], ["d1s2"], true, 1],
    ]);
  });

  it("leaves out chapters kept in the original language", () => {
    const a = identityAlignment(source, target, 1, new Set([2]))!;
    expect(a.units.map((u) => u.include)).toEqual([false, true, false]);
  });

  it("gives up when the tables of contents differ", () => {
    expect(identityAlignment(source, target.slice(1), 1)).toBeNull();
    expect(
      identityAlignment(source, [target[0]!, target[1]!, { ...target[2]!, id: "d1s9" }], 1),
    ).toBeNull();
    expect(identityAlignment([], [], 1)).toBeNull();
  });
});
