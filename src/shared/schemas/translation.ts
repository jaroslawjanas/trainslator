import { z } from "zod";
import { IsoDate, SchemaVersion, Usage } from "./common.ts";
import { KbKind } from "./kb.ts";

export const UnitRole = z.enum([
  "heading",
  "paragraph",
  "list-item",
  "table-cell",
  "caption",
  "title",
  "preformatted",
  "break",
  "alt",
  "toc",
]);
export type UnitRole = z.infer<typeof UnitRole>;

export const Placeholder = z.object({
  n: z.number().int().positive(),
  kind: z.enum(["g", "x"]),
  /** Must appear exactly once in the translation. Optional ones may be dropped. */
  required: z.boolean(),
  /** Original opening tag (g) or the whole element source (x). */
  open: z.string(),
  /** Original closing tag (g only). */
  close: z.string().nullable(),
  /** Element name, for display. */
  label: z.string(),
  /** An x placeholder standing for a literal newline in preformatted text. */
  newline: z.boolean(),
  /** For images: the alt text is translated as a separate unit. */
  hasAlt: z.boolean(),
});
export type Placeholder = z.infer<typeof Placeholder>;

export const TransUnit = z.object({
  key: z.string(),
  /** Archive path of the file this unit belongs to. */
  file: z.string(),
  docIndex: z.number().int(),
  /** Flow unit index, or -1 for units that aren't flow units (alt text, TOC labels). */
  index: z.number().int(),
  kind: z.enum(["text", "alt", "toc"]),
  role: UnitRole,
  headingLevel: z.number().int(),
  inFootnote: z.boolean(),
  /** Text with placeholders, as sent to the AI. */
  text: z.string(),
  translate: z.boolean(),
  skipReason: z.string().nullable(),
  placeholders: z.array(Placeholder),
  /** Raw source written before/after the translation (moved wrappers, anchors, whitespace). */
  prefix: z.string(),
  suffix: z.string(),
  dropCap: z.object({ open: z.string(), close: z.string() }).nullable(),
  pre: z.boolean(),
  /** Range replaced in the file: content range, or the attribute value range for alt units. */
  start: z.number().int(),
  end: z.number().int(),
  /** Alt units: the attribute's quote character. */
  quote: z.enum(['"', "'"]).nullable(),
  /** Alt text inside a text unit: owning unit index and placeholder number. */
  owner: z.object({ unitIndex: z.number().int(), n: z.number().int() }).nullable(),
  /** Normalizations applied, for diagnostics. */
  notes: z.array(z.string()),
});
export type TransUnit = z.infer<typeof TransUnit>;

export const DocUnits = z.object({
  schemaVersion: SchemaVersion,
  extractorVersion: z.number().int(),
  docIndex: z.number().int(),
  path: z.string(),
  units: z.array(TransUnit),
});
export type DocUnits = z.infer<typeof DocUnits>;

export const PlanChapter = z.object({
  id: z.string(),
  title: z.string(),
  /** Segment id this chapter comes from, or null for text outside the TOC. */
  segmentId: z.string().nullable(),
  chunks: z.array(z.number().int()),
});
export type PlanChapter = z.infer<typeof PlanChapter>;

export const PlanChunk = z.object({
  index: z.number().int(),
  chapterId: z.string(),
  unitKeys: z.array(z.string()),
  sourceTokens: z.number(),
});
export type PlanChunk = z.infer<typeof PlanChunk>;

export const Phase3Plan = z.object({
  schemaVersion: SchemaVersion,
  extractorVersion: z.number().int(),
  chunkTokens: z.number().int(),
  chapters: z.array(PlanChapter),
  chunks: z.array(PlanChunk),
  /** Units translated in the TOC step (nav labels, NCX labels). */
  tocUnitKeys: z.array(z.string()),
  createdAt: IsoDate,
});
export type Phase3Plan = z.infer<typeof Phase3Plan>;

export const UnitStatus = z.enum(["ok", "flagged", "refused"]);
export type UnitStatus = z.infer<typeof UnitStatus>;

export const UnitResult = z.object({
  key: z.string(),
  /** Best translation (placeholder form), or null when there is none. */
  text: z.string().nullable(),
  status: UnitStatus,
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});
export type UnitResult = z.infer<typeof UnitResult>;

export const ChunkResult = z.object({
  schemaVersion: SchemaVersion,
  chunkIndex: z.number().int(),
  chapterId: z.string(),
  inputsHash: z.string(),
  promptVersion: z.number().int(),
  modelId: z.string(),
  instruction: z.string().nullable(),
  finishedAt: IsoDate,
  usage: Usage,
  units: z.array(UnitResult),
  /** Earlier versions, newest last (re-translations). */
  history: z.array(z.object({ at: IsoDate, units: z.array(UnitResult) })),
});
export type ChunkResult = z.infer<typeof ChunkResult>;

export const ManualEdits = z.object({
  schemaVersion: SchemaVersion,
  edits: z.record(
    z.string(),
    z.object({ text: z.string(), at: IsoDate, previous: z.string().nullable() }),
  ),
});
export type ManualEdits = z.infer<typeof ManualEdits>;

export const GlossaryTerm = z.object({
  kind: KbKind,
  source: z.string(),
  target: z.string(),
  note: z.string(),
  chunkIndex: z.number().int(),
  /** Set when a later chunk proposed a different translation. */
  conflict: z.string().nullable(),
});
export type GlossaryTerm = z.infer<typeof GlossaryTerm>;

export const Glossary = z.object({
  schemaVersion: SchemaVersion,
  terms: z.array(GlossaryTerm),
});
export type Glossary = z.infer<typeof Glossary>;

export const TocTranslations = z.object({
  schemaVersion: SchemaVersion,
  title: z.string().nullable(),
  items: z.record(z.string(), z.string()),
  /** How each item was produced. */
  sources: z.record(z.string(), z.enum(["heading", "ai", "edited"])),
  finishedAt: IsoDate,
});
export type TocTranslations = z.infer<typeof TocTranslations>;
