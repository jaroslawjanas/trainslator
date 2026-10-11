import { describe, expect, it } from "vitest";
import { findMatches } from "./search.ts";

describe("search", () => {
  it("ignores case and accents, and maps matches back to the original text", () => {
    const text = "Źródło światła, a potem ŹRÓDŁO.";
    const matches = findMatches(text, "zrodlo");
    expect(matches.map((m) => text.slice(m.start, m.end))).toEqual(["Źródło", "ŹRÓDŁO"]);
    expect(findMatches("Łódź", "lodz")).toEqual([{ start: 0, end: 4 }]);
  });

  it("counts ß as ss, covering the whole ß", () => {
    const text = "Die Straße, die STRASSE und die GROẞE Brücke.";
    const slices = (q: string) => findMatches(text, q).map((m) => text.slice(m.start, m.end));
    expect(slices("strasse")).toEqual(["Straße", "STRASSE"]);
    expect(slices("Straße")).toEqual(["Straße", "STRASSE"]);
    expect(slices("grosse")).toEqual(["GROẞE"]);
    // A match that ends or starts inside ß takes all of it.
    expect(slices("stras")).toEqual(["Straß", "STRAS"]);
    expect(slices("se,")).toEqual(["ße,"]);
    // Accents still map back exactly, combining marks included.
    expect(findMatches("Café x", "cafe")).toEqual([{ start: 0, end: 5 }]);
  });

  it("finds nothing for an empty query", () => {
    expect(findMatches("anything", "  ")).toEqual([]);
  });
});

describe("search options", () => {
  it("matches case and accents exactly when asked", () => {
    expect(findMatches("Źródło i źródło", "źródło", { exact: true })).toEqual([
      { start: 9, end: 15 },
    ]);
    expect(findMatches("Zrodlo", "źródło", { exact: true })).toEqual([]);
  });

  it("matches whole words only when asked", () => {
    const text = "Bob met Bobby and bob.";
    expect(
      findMatches(text, "bob", { wholeWord: true }).map((m) => text.slice(m.start, m.end)),
    ).toEqual(["Bob", "bob"]);
  });
});
