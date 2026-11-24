import { z } from "zod";
import { Id, IsoDate, SchemaVersion } from "./common.ts";

export const Project = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  name: z.string().min(1),
  /** BCP-47 tag of the source language: English, German or Polish for now (languages/index.ts). */
  sourceLang: z.string().min(2),
  /** BCP-47 tag of the target language. */
  targetLang: z.string().min(2),
  targetLangName: z.string(),
  /** ISO 15924 script of the target language, e.g. Latn, Cyrl, Hans. Null when unknown. */
  targetScript: z.string().nullable(),
  direction: z.enum(["ltr", "rtl"]),
  options: z.object({
    pauseAfterPhase: z.boolean(),
  }),
  /** The Usage page counts requests sent from then on; null counts all. The call log keeps every request. */
  usageResetAt: IsoDate.nullable().default(null),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Project = z.infer<typeof Project>;

/**
 * "stopped" is never saved: a phase saved as "running" is reported that way
 * once its job isn't active any more (cancelled, failed, paused, or cut
 * short by a restart).
 */
export const PhaseState = z.enum([
  "none",
  "running",
  "stopped",
  "done",
  "done_with_errors",
  "failed",
]);
export type PhaseState = z.infer<typeof PhaseState>;

export const Pair = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  title: z.string(),
  sourceFileName: z.string(),
  targetFileName: z.string(),
  createdAt: IsoDate,
  phase1: z.object({
    state: PhaseState,
    finishedAt: IsoDate.nullable(),
    entries: z.number().int().nonnegative().nullable(),
  }),
  /** Set when the pair was made from a finished book: its knowledge base is the book's. */
  fromBook: z.object({ bookId: Id, title: z.string(), madeAt: IsoDate }).nullable().default(null),
  /** When one of the two EPUBs was last replaced; null if never. */
  filesChangedAt: IsoDate.nullable().default(null),
  /**
   * The knowledge base was cleared: the next Learning run asks the models
   * anew instead of reusing saved answers. Cleared when a run finishes.
   */
  askAnew: z.boolean().default(false),
});
export type Pair = z.infer<typeof Pair>;

/** A copy of a pair's knowledge base, saved before it was cleared or replaced by another copy. */
export const PairSavedKnowledge = z.object({
  id: Id,
  savedAt: IsoDate,
  reason: z.enum(["clear", "restore"]),
  /** Same content, same hash: a knowledge base is saved once. */
  contentHash: z.string(),
  entries: z.number().int(),
  open: z.number().int(),
  /** Entries you set or answered. */
  locked: z.number().int(),
  /** Phase 1 as it stood, restored with the copy. */
  phase1: z.object({
    state: z.string(),
    finishedAt: IsoDate.nullable(),
    entries: z.number().int().nonnegative().nullable(),
  }),
});
export type PairSavedKnowledge = z.infer<typeof PairSavedKnowledge>;

/** A pair's saved knowledge bases, oldest first. */
export const PairHistory = z.object({
  schemaVersion: SchemaVersion,
  knowledgeBases: z.array(PairSavedKnowledge),
});
export type PairHistory = z.infer<typeof PairHistory>;

export const RefKbMode = z.enum(["auto", "all", "relevant"]);
export type RefKbMode = z.infer<typeof RefKbMode>;

/**
 * How phase 3 sends a chapter: in chunks of about 1,700 words with a few
 * paragraphs of context, or whole (very long chapters in a few parts) with
 * the summaries of the chapters before it.
 */
export const TranslationMode = z.enum(["chunks", "chapters"]);
export type TranslationMode = z.infer<typeof TranslationMode>;

export const Book = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  title: z.string(),
  sourceFileName: z.string(),
  /** Reference pairs used for this book, in prompt order. */
  pairIds: z.array(Id),
  refKbMode: RefKbMode,
  translationMode: TranslationMode.default("chunks"),
  options: z.object({
    newIdentifier: z.boolean(),
    removeEmbeddedFonts: z.boolean(),
  }),
  createdAt: IsoDate,
  phase2: z.object({
    state: PhaseState,
    finishedAt: IsoDate.nullable(),
    stepsDone: z.number().int().nonnegative(),
  }),
  phase3: z.object({
    state: PhaseState,
    finishedAt: IsoDate.nullable(),
  }),
  build: z.object({
    builtAt: IsoDate.nullable(),
    fileName: z.string().nullable(),
  }),
  /**
   * The knowledge base was cleared: the next Reading run asks the models
   * anew instead of reusing saved answers. Cleared when a run finishes.
   */
  askAnew: z.boolean().default(false),
});
export type Book = z.infer<typeof Book>;
