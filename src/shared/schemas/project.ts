import { z } from "zod";
import { Id, IsoDate, SchemaVersion } from "./common.ts";

export const Project = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  name: z.string().min(1),
  /** Only "en" is offered for now. */
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
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Project = z.infer<typeof Project>;

export const PhaseState = z.enum(["none", "running", "done", "done_with_errors", "failed"]);
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
});
export type Pair = z.infer<typeof Pair>;

export const RefKbMode = z.enum(["auto", "all", "relevant"]);
export type RefKbMode = z.infer<typeof RefKbMode>;

export const Book = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  title: z.string(),
  sourceFileName: z.string(),
  /** Reference pairs used for this book, in prompt order. */
  pairIds: z.array(Id),
  refKbMode: RefKbMode,
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
});
export type Book = z.infer<typeof Book>;
