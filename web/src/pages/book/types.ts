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
