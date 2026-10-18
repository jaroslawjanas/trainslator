import { z } from "zod";
import { Id, IsoDate, SchemaVersion } from "./common.ts";

export const KB_KINDS = [
  "person",
  "place",
  "organization",
  "named_thing",
  "term",
  "phrase",
  "wordplay",
  "other",
] as const;
export const KbKind = z.enum(KB_KINDS);
export type KbKind = z.infer<typeof KbKind>;

export const KB_TREATMENTS = [
  "kept",
  "translated",
  "transliterated",
  "adapted",
  "omitted",
  "other",
] as const;
export const KbTreatment = z.enum(KB_TREATMENTS);
export type KbTreatment = z.infer<typeof KbTreatment>;

export const KeyValue = z.object({ key: z.string(), value: z.string() });
export type KeyValue = z.infer<typeof KeyValue>;

export const KbExample = z.object({
  source: z.string(),
  target: z.string().nullable(),
});
export type KbExample = z.infer<typeof KbExample>;

export const KbStatus = z.enum(["auto", "locked", "open"]);
export type KbStatus = z.infer<typeof KbStatus>;

export const KbEntry = z.object({
  id: Id,
  kind: KbKind,
  source: z.string().min(1),
  aliases: z.array(z.string()),
  /** Dictionary form of the translation; null when undecided or omitted. */
  target: z.string().nullable(),
  /** Other forms of the translation seen in text (inflected forms, variants). */
  targetSeen: z.array(z.string()),
  treatment: KbTreatment.nullable(),
  attributes: z.array(KeyValue),
  note: z.string(),
  examples: z.array(KbExample),
  /** Units (pairs) or segments (books) where the entry was seen. Computed in code. */
  refs: z.array(z.string()),
  status: KbStatus,
  /** For open entries: what still needs deciding. */
  question: z.string().nullable(),
  /** "phase3": a term coined while translating a book, added when the book became a reference pair. */
  origin: z.enum(["phase1", "phase2", "phase3", "user"]),
  updatedAt: IsoDate,
});
export type KbEntry = z.infer<typeof KbEntry>;

export const StyleRule = z.object({
  id: Id,
  rule: z.string().min(1),
  examples: z.array(KbExample),
  status: z.enum(["auto", "locked"]),
});
export type StyleRule = z.infer<typeof StyleRule>;

export const Kb = z.object({
  schemaVersion: SchemaVersion,
  scope: z.enum(["pair", "book"]),
  title: z.string(),
  entries: z.array(KbEntry),
  styleRules: z.array(StyleRule),
});
export type Kb = z.infer<typeof Kb>;

/**
 * Your changes to a KB. Automatic rebuilds (phase 1 re-runs, phase 2 restores)
 * re-apply these, so they are never lost.
 */
export const KbOverrides = z.object({
  schemaVersion: SchemaVersion,
  /** Keyed by entry id. `entry: null` = deleted by you. */
  entries: z.record(
    z.string(),
    z.object({
      key: z.string(),
      entry: KbEntry.nullable(),
      at: IsoDate,
    }),
  ),
  /** Keyed by rule id. `rule: null` = deleted by you. */
  styleRules: z.record(
    z.string(),
    z.object({
      rule: StyleRule.nullable(),
      at: IsoDate,
    }),
  ),
});
export type KbOverrides = z.infer<typeof KbOverrides>;

export function emptyKb(scope: "pair" | "book", title: string): Kb {
  return { schemaVersion: 1, scope, title, entries: [], styleRules: [] };
}

export function emptyOverrides(): KbOverrides {
  return { schemaVersion: 1, entries: {}, styleRules: {} };
}
