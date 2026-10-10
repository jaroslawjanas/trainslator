import { z } from "zod";
import { Id, IsoDate, SchemaVersion, Usage } from "./common.ts";
import { KbKind } from "./kb.ts";
import { TranslationMode } from "./project.ts";

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
  /** How the chunk was sent; null for results from before this was recorded. */
  mode: TranslationMode.nullable().default(null),
  /** Reasoning setting used: the effort, "on" (no effort given) or "off". */
  reasoning: z.string().nullable().default(null),
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

/** Where saved passages came from: model and settings, shared by many passages. */
export const PassageOrigin = z.object({
  modelId: z.string(),
  mode: TranslationMode.nullable(),
  reasoning: z.string().nullable(),
});
export type PassageOrigin = z.infer<typeof PassageOrigin>;

/** Everything a saved translation holds, enough to restore it. */
export const SavedTranslationContent = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  origins: z.array(PassageOrigin),
  /** By unit key; `origin` indexes `origins`. */
  units: z.record(z.string(), UnitResult.omit({ key: true }).extend({ origin: z.number().int() })),
  edits: ManualEdits.shape.edits,
  toc: TocTranslations.nullable(),
  glossary: z.array(GlossaryTerm),
});
export type SavedTranslationContent = z.infer<typeof SavedTranslationContent>;

export const SaveReason = z.enum(["run", "redo", "restore", "build", "manual"]);
export type SaveReason = z.infer<typeof SaveReason>;

/** A saved translation as listed in the history. */
export const SavedTranslation = z.object({
  id: Id,
  savedAt: IsoDate,
  reason: SaveReason,
  /** Same content, same hash: a translation is saved once. */
  contentHash: z.string(),
  modes: z.array(TranslationMode),
  /** Model labels at the time of saving. */
  models: z.array(z.string()),
  reasoning: z.array(z.string()),
  /** What the passages' latest translations cost. */
  usage: Usage,
  counts: z.object({
    units: z.number().int(),
    ok: z.number().int(),
    flagged: z.number().int(),
    refused: z.number().int(),
    pending: z.number().int(),
    edited: z.number().int(),
  }),
});
export type SavedTranslation = z.infer<typeof SavedTranslation>;

export const SavedBuild = z.object({
  id: Id,
  builtAt: IsoDate,
  fileName: z.string(),
  bytes: z.number().int(),
  /** The saved translation it was built from. */
  translationId: Id.nullable(),
  useBestAttempts: z.boolean(),
  flaggedUsed: z.number().int(),
  keptSource: z.number().int(),
});
export type SavedBuild = z.infer<typeof SavedBuild>;

/** A saved copy of the book's knowledge base with phase 2's chapter notes. */
export const SavedKnowledge = z.object({
  id: Id,
  savedAt: IsoDate,
  reason: z.enum(["rebuild", "restore"]),
  contentHash: z.string(),
  entries: z.number().int(),
  open: z.number().int(),
  /** Entries you set or answered. */
  locked: z.number().int(),
  /** Phase 2 as it stood, restored with the copy. */
  phase2: z.object({
    state: z.string(),
    finishedAt: IsoDate.nullable(),
    stepsDone: z.number().int(),
  }),
});
export type SavedKnowledge = z.infer<typeof SavedKnowledge>;

/** Every saved translation, build and knowledge base of a book, oldest first. */
export const BookHistory = z.object({
  schemaVersion: SchemaVersion,
  translations: z.array(SavedTranslation),
  builds: z.array(SavedBuild),
  knowledgeBases: z.array(SavedKnowledge).default([]),
});
export type BookHistory = z.infer<typeof BookHistory>;
