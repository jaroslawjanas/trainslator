import type { Kb, KbEntry, KbOverrides } from "../shared/schemas/kb.ts";
import type { GlossaryTerm } from "../shared/schemas/translation.ts";
import { entryKeys, normalizeKey, slugId, uniqueId } from "./model.ts";
import { deletedKeys } from "./overrides.ts";

/**
 * A finished book's knowledge base, made into a reference pair's: the same
 * entries and your changes, with chapter refs moved from the book's segments
 * to the pair's alignment units. Coined terms the knowledge base lacks can be
 * added as entries of their own (origin "phase3").
 */
export interface PairKbInput {
  kb: Kb;
  overrides: KbOverrides;
  /** The pair's title. */
  title: string;
  /** The source language, for name keys. */
  lang: string;
  /** Book segment id → alignment unit id. Refs without one are dropped. */
  unitOf: ReadonlyMap<string, string>;
  /** Coined terms to add; null leaves them out. */
  coined: GlossaryTerm[] | null;
  /** Translation chunk → the book segment of its chapter, for coined terms' refs. */
  segmentOfChunk: ReadonlyMap<number, string>;
  now: string;
}

function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

export function pairKbFromBook(input: PairKbInput): {
  kb: Kb;
  overrides: KbOverrides;
  coinedAdded: number;
  /** How many of the added coined terms were translated two ways. */
  coinedConflicts: number;
} {
  const { kb, overrides, lang, unitOf } = input;
  const mapRefs = (refs: string[]) => [
    ...new Set(refs.flatMap((r) => (unitOf.has(r) ? [unitOf.get(r)!] : []))),
  ];
  const entries: KbEntry[] = kb.entries.map((e) => ({ ...e, refs: mapRefs(e.refs) }));

  let coinedAdded = 0;
  let coinedConflicts = 0;
  if (input.coined) {
    // Terms the knowledge base has, or that you deleted from it, aren't added.
    const keys = new Set([
      ...entries.flatMap((e) => entryKeys(e, lang)),
      ...deletedKeys(overrides),
    ]);
    const taken = new Set([...entries.map((e) => e.id), ...Object.keys(overrides.entries)]);
    for (const t of input.coined) {
      const key = normalizeKey(t.source, lang);
      if (!key || keys.has(key) || !t.target.trim()) continue;
      keys.add(key);
      const segment = input.segmentOfChunk.get(t.chunkIndex);
      const unit = segment ? unitOf.get(segment) : undefined;
      entries.push({
        id: uniqueId(slugId("c", t.source), taken),
        kind: t.kind,
        source: t.source,
        aliases: [],
        target: t.target,
        targetSeen: [],
        treatment: sameText(t.source, t.target) ? "kept" : null,
        attributes: [],
        note: [t.note.trim(), t.conflict ? `Translated differently later: ${t.conflict}.` : ""]
          .filter(Boolean)
          .join(" "),
        examples: [],
        refs: unit ? [unit] : [],
        status: "auto",
        question: null,
        origin: "phase3",
        updatedAt: input.now,
      });
      coinedAdded++;
      if (t.conflict) coinedConflicts++;
    }
  }

  return {
    kb: { ...kb, scope: "pair", title: input.title, entries },
    overrides: {
      ...overrides,
      entries: Object.fromEntries(
        Object.entries(overrides.entries).map(([id, o]) => [
          id,
          { ...o, entry: o.entry ? { ...o.entry, refs: mapRefs(o.entry.refs) } : null },
        ]),
      ),
    },
    coinedAdded,
    coinedConflicts,
  };
}
