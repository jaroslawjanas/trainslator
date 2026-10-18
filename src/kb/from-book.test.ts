import { describe, expect, it } from "vitest";
import { emptyOverrides, type Kb, type KbEntry } from "../shared/schemas/kb.ts";
import type { GlossaryTerm } from "../shared/schemas/translation.ts";
import { pairKbFromBook } from "./from-book.ts";
import { deleteEntry, lockEntry } from "./overrides.ts";

const NOW = "2026-10-19T12:00:00.000Z";

function entry(id: string, source: string, patch: Partial<KbEntry> = {}): KbEntry {
  return {
    id,
    kind: "person",
    source,
    aliases: [],
    target: source,
    targetSeen: [],
    treatment: "kept",
    attributes: [],
    note: "",
    examples: [],
    refs: [],
    status: "auto",
    question: null,
    origin: "phase2",
    updatedAt: NOW,
    ...patch,
  };
}

function term(source: string, target: string, patch: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return { kind: "person", source, target, note: "", chunkIndex: 0, conflict: null, ...patch };
}

const kb: Kb = {
  schemaVersion: 1,
  scope: "book",
  title: "The Lantern Keeper",
  entries: [
    entry("b_mira", "Mira", { refs: ["d1s1", "d1s2", "d1s9"] }),
    entry("b_order", "Order of the Lamp", {
      kind: "organization",
      aliases: ["the Order"],
      target: "Zakon Lampy",
      treatment: "translated",
      refs: ["d1s2"],
    }),
  ],
  styleRules: [],
};
const unitOf = new Map([
  ["d1s1", "a1"],
  ["d1s2", "a2"],
]);
const base = {
  kb,
  overrides: emptyOverrides(),
  title: "Latarniczka",
  lang: "en",
  unitOf,
  coined: null,
  segmentOfChunk: new Map<number, string>(),
  now: NOW,
};

describe("a book's knowledge base for a reference pair", () => {
  it("keeps the entries, with refs moved from the book's chapters to the pair's units", () => {
    const out = pairKbFromBook(base);
    expect(out.kb).toMatchObject({ scope: "pair", title: "Latarniczka" });
    expect(out.kb.entries.map((e) => [e.id, e.refs])).toEqual([
      ["b_mira", ["a1", "a2"]],
      ["b_order", ["a2"]],
    ]);
    expect(out.coinedAdded).toBe(0);
  });

  it("moves the refs of your own changes too", () => {
    const overrides = lockEntry(emptyOverrides(), { ...kb.entries[0]!, note: "The keeper." }, "en");
    const out = pairKbFromBook({ ...base, overrides });
    expect(out.overrides.entries.b_mira?.entry?.refs).toEqual(["a1", "a2"]);
    expect(out.overrides.entries.b_mira?.entry?.note).toBe("The keeper.");
  });

  it("adds coined terms only when the knowledge base doesn't have them", () => {
    const overrides = deleteEntry(emptyOverrides(), entry("u_gone", "Gone"), "en");
    const out = pairKbFromBook({
      ...base,
      overrides,
      coined: [
        term("Mira", "Mira"),
        // "the Order" is an alias of an entry; articles don't count.
        term("Order", "Zakon", { kind: "organization" }),
        term("Brannock", "Brannock", { chunkIndex: 3, note: "The lighthouse." }),
        term("lamp-oil", "olej lampowy", {
          kind: "term",
          chunkIndex: 9,
          conflict: 'chunk 7 used "nafta"',
        }),
        // You deleted this one from the knowledge base.
        term("Gone", "Usunięty"),
        term("Brannock", "Branok"),
      ],
      segmentOfChunk: new Map([[3, "d1s2"]]),
    });
    const added = out.kb.entries.filter((e) => e.origin === "phase3");
    expect(added).toEqual([
      expect.objectContaining({
        id: "c_brannock",
        source: "Brannock",
        target: "Brannock",
        treatment: "kept",
        note: "The lighthouse.",
        refs: ["a2"],
        status: "auto",
      }),
      expect.objectContaining({
        id: "c_lamp_oil",
        kind: "term",
        treatment: null,
        note: 'Translated differently later: chunk 7 used "nafta".',
        refs: [],
      }),
    ]);
    expect(out.coinedAdded).toBe(2);
    expect(out.coinedConflicts).toBe(1);
    // The book's own knowledge base isn't changed.
    expect(kb.entries).toHaveLength(2);
  });
});
