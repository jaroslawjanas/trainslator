import type { BookSetup, EpubStructure } from "../../../../src/shared/schemas/epub.ts";
import type { Book, Pair } from "../../api/types.ts";

export interface BookDetail {
  book: Book;
  structure: EpubStructure;
  setup: BookSetup;
  pairs: Pair[];
  reference: { mode: "all" | "relevant"; tokens: number; entries: number; totalEntries: number };
}

export interface StepView {
  step: number;
  segmentId: string;
  title: string;
  part: { index: number; count: number } | null;
  synopsis: string;
  outcomes: {
    op: string;
    id: string | null;
    source: string | null;
    result: "applied" | "rejected" | "suggestion";
    message: string;
    reason: string;
    entryId: string | null;
  }[];
  finishedAt: string;
}

export interface ChapterView {
  id: string;
  title: string;
  chunks: number;
  units: number;
  ok: number;
  flagged: number;
  refused: number;
  pending: number;
  edited: number;
}

export interface UnitView {
  key: string;
  urlKey: string;
  chunkIndex: number;
  role: string;
  kind: string;
  source: string;
  placeholders: { n: number; kind: "g" | "x"; label: string; required: boolean }[];
  translation: string | null;
  aiTranslation: string | null;
  status: "ok" | "flagged" | "refused" | "pending" | "edited";
  warnings: string[];
  errors: string[];
  instruction: string | null;
}

export interface SavedTranslationView {
  id: string;
  number: number;
  savedAt: string;
  reason: "run" | "redo" | "restore" | "build" | "manual";
  modes: ("chunks" | "chapters")[];
  models: string[];
  reasoning: string[];
  usage: { cost: number | null; calls: number };
  counts: {
    units: number;
    ok: number;
    flagged: number;
    refused: number;
    pending: number;
    edited: number;
  };
  builds: { id: string; builtAt: string; fileName: string; bytes: number }[];
}

export interface SavedKnowledgeView {
  id: string;
  number: number;
  savedAt: string;
  reason: "rebuild" | "restore";
  entries: number;
  open: number;
  locked: number;
}

export interface HistoryView {
  knowledgeBases: SavedKnowledgeView[];
  /** The saved knowledge base the current one matches, if any. */
  currentKnowledge: string | null;
  translations: SavedTranslationView[];
  /** The book's translation now: which saved one it matches, if any. */
  current: { savedAs: string | null } | null;
}

export interface VersionCell {
  text: string | null;
  status: "ok" | "flagged" | "refused" | "pending" | "edited";
  edited: boolean;
}

/** A passage on the Review page, in every version shown. */
export interface ReviewUnit {
  key: string;
  urlKey: string;
  role: string;
  source: string;
  placeholders: { n: number; kind: "g" | "x"; label: string; required: boolean }[];
  /** By version: "current" or a saved translation's id. */
  versions: Record<string, VersionCell>;
}
