import type { Book, Job, Pair } from "../api/types.ts";

/** What a stage mark shows. */
export type MarkState = "none" | "neutral" | "running" | "done" | "warning" | "attention";

export const ACTIVE_JOB = ["queued", "running", "pausing"];

export function phaseMark(state: string): MarkState {
  switch (state) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "done_with_errors":
      return "warning";
    case "failed":
      return "attention";
    default:
      return "none";
  }
}

export function phaseText(state: string): string {
  switch (state) {
    case "done":
      return "Done";
    case "running":
      return "Running";
    case "done_with_errors":
      return "Done, with errors";
    case "failed":
      return "Failed";
    default:
      return "Not run yet";
  }
}

export interface StageDef {
  key: string;
  label: string;
  mark: (ctx: StageContext) => MarkState;
}

export interface StageContext {
  book?: Book;
  pair?: Pair;
  alignmentConfirmed?: boolean;
  jobs: Job[];
}

function running(ctx: StageContext, targetId: string, types: Job["type"][]): boolean {
  return ctx.jobs.some(
    (j) => j.targetId === targetId && types.includes(j.type) && ACTIVE_JOB.includes(j.status),
  );
}

export const BOOK_STAGES: StageDef[] = [
  { key: "setup", label: "Setup", mark: () => "neutral" },
  {
    key: "read",
    label: "Reading",
    mark: (c) =>
      c.book && running(c, c.book.id, ["phase2"])
        ? "running"
        : phaseMark(c.book?.phase2.state ?? "none"),
  },
  { key: "kb", label: "Knowledge base", mark: () => "neutral" },
  {
    key: "translate",
    label: "Translation",
    mark: (c) =>
      c.book && running(c, c.book.id, ["phase3", "retranslate"])
        ? "running"
        : phaseMark(c.book?.phase3.state ?? "none"),
  },
  {
    key: "build",
    label: "Build",
    mark: (c) =>
      c.book && running(c, c.book.id, ["build"])
        ? "running"
        : c.book?.build.builtAt
          ? "done"
          : "none",
  },
];

export const PAIR_STAGES: StageDef[] = [
  {
    key: "alignment",
    label: "Alignment",
    mark: (c) => (c.alignmentConfirmed ? "done" : "none"),
  },
  {
    key: "learn",
    label: "Learning",
    mark: (c) =>
      c.pair && running(c, c.pair.id, ["phase1"])
        ? "running"
        : phaseMark(c.pair?.phase1.state ?? "none"),
  },
  { key: "kb", label: "Knowledge base", mark: () => "neutral" },
];

export function defaultBookStage(book: Book): string {
  if (book.phase3.state !== "none") return "translate";
  if (book.phase2.state !== "none") return "kb";
  return "setup";
}

export function defaultPairStage(pair: { phase1: { state: string } }): string {
  return pair.phase1.state === "none" ? "alignment" : "kb";
}
