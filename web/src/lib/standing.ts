import type { BookCounts, PairCounts } from "../../../src/shared/overview.ts";
import type { Book, Job, Pair } from "../api/types.ts";
import { count, plural, relativeTime } from "./format.ts";
import { ACTIVE_JOB, learnedBeforeReplace, type MarkState } from "./stages.ts";

/** Where to go next from a row: a page of the app, or the built EPUB. */
export interface NextStep {
  label: string;
  /** A page of the app. */
  to?: string;
  /** A file to download. */
  href?: string;
  fileName?: string;
  /** The one thing to do now, as opposed to something you may do. */
  primary: boolean;
}

/** One sentence on where a book or pair stands, its mark, and the next step. */
export interface Standing {
  mark: MarkState;
  text: string;
  next: NextStep | null;
}

function active(jobs: Job[], targetId: string): Job | undefined {
  return jobs.find((j) => j.targetId === targetId && ACTIVE_JOB.includes(j.status));
}

const when = (iso: string | null) => (iso ? ` ${relativeTime(iso)}` : "");

/**
 * Where a book stands. The counts come from the server a moment after the
 * book itself: until they are there, the sentence claims nothing about
 * open questions or passages.
 */
export function bookStanding(
  book: Book,
  counts: BookCounts | undefined,
  jobs: Job[],
  projectPath: string,
): Standing {
  const base = `${projectPath}/books/${book.id}`;
  const job = active(jobs, book.id);
  if (job) {
    const [text, stage] =
      job.type === "phase2"
        ? ["Reading now.", "read"]
        : job.type === "build"
          ? ["Building the EPUB now.", "build"]
          : ["Translating now.", "translate"];
    return {
      mark: "running",
      text,
      next: { label: "See progress", to: `${base}/${stage}`, primary: false },
    };
  }
  const read = book.phase2.state;
  const translated = book.phase3.state;
  const passages = counts ? `${plural(counts.passages, "passage")}` : "";

  if (translated === "failed" || translated === "stopped")
    return {
      mark: translated === "failed" ? "attention" : "warning",
      text:
        translated === "failed"
          ? "The translation failed."
          : `The translation stopped before it finished${counts ? `: ${counts.pending.toLocaleString()} of ${(counts.passages + counts.pending + counts.attention).toLocaleString()} passages are left` : ""}.`,
      next: { label: "Continue translating", to: `${base}/translate`, primary: true },
    };

  if (translated === "done" || translated === "done_with_errors") {
    // The counts arrive a moment later; until then, don't show a clean mark for a run that wasn't.
    if (!counts && translated === "done_with_errors")
      return {
        mark: "warning",
        text: `Translated${when(book.phase3.finishedAt)}. Some passages need attention.`,
        next: { label: "Check the passages", to: `${base}/translate`, primary: true },
      };
    if (counts && counts.attention > 0)
      return {
        mark: "warning",
        text: `Translated${when(book.phase3.finishedAt)}. ${counts.attention.toLocaleString()} of ${(counts.passages + counts.attention).toLocaleString()} passages need attention.`,
        next: {
          label: `Check ${plural(counts.attention, "passage")}`,
          to: `${base}/translate`,
          primary: true,
        },
      };
    if (counts && counts.pending > 0)
      return {
        mark: "warning",
        text: `Translated${when(book.phase3.finishedAt)}. ${plural(counts.pending, "passage")} not translated yet.`,
        next: { label: "Translate the rest", to: `${base}/translate`, primary: true },
      };
    const clean = counts ? ` ${passages}, none need attention.` : "";
    const built = book.build.builtAt;
    // A build older than the translation, or than your edits to it, isn't what you'd want to download.
    if (built && counts?.buildCurrent === false)
      return {
        mark: "warning",
        text: `Translated${when(book.phase3.finishedAt)}.${clean} The EPUB was built before the translation last changed.`,
        next: { label: "Build again", to: `${base}/build`, primary: true },
      };
    if (built && (!book.phase3.finishedAt || built >= book.phase3.finishedAt))
      return {
        mark: "done",
        text: `Built${when(built)}.${clean}`,
        next: {
          label: "Download EPUB",
          href: `/api${base}/output`,
          fileName: book.build.fileName ?? undefined,
          primary: false,
        },
      };
    return {
      mark: "done",
      text: `Translated${when(book.phase3.finishedAt)}.${clean}`,
      next: { label: "Build the EPUB", to: `${base}/build`, primary: true },
    };
  }

  if (read === "failed" || read === "stopped")
    return {
      mark: read === "failed" ? "attention" : "warning",
      text: read === "failed" ? "Reading failed." : "Reading stopped before it finished.",
      next: { label: "Continue reading", to: `${base}/read`, primary: true },
    };

  if (read === "done" || read === "done_with_errors") {
    if (counts && counts.openQuestions > 0)
      return {
        mark: "warning",
        text: `Read${when(book.phase2.finishedAt)}. ${plural(counts.openQuestions, "open question")} to answer before translating.`,
        next: {
          label: `Answer ${plural(counts.openQuestions, "question")}`,
          to: `${base}/kb`,
          primary: true,
        },
      };
    return {
      mark: read === "done" ? "done" : "warning",
      text: `Read${when(book.phase2.finishedAt)}${read === "done_with_errors" ? ", with errors" : ""}.${counts ? ` ${plural(counts.entries, "entry", "entries")} in its knowledge base.` : ""}`,
      next: { label: "Translate", to: `${base}/translate`, primary: true },
    };
  }

  return {
    mark: "none",
    text: "Not read yet.",
    next: { label: "Set up and read", to: `${base}/setup`, primary: true },
  };
}

/** Where a reference pair stands. */
export function pairStanding(
  pair: Pair,
  counts: PairCounts | undefined,
  jobs: Job[],
  projectPath: string,
): Standing {
  const base = `${projectPath}/pairs/${pair.id}`;
  if (active(jobs, pair.id))
    return {
      mark: "running",
      text: "Learning now.",
      next: { label: "See progress", to: `${base}/learn`, primary: false },
    };
  const { state, entries, finishedAt } = pair.phase1;
  if (learnedBeforeReplace(pair))
    return {
      mark: "warning",
      text: "Learned before one of its books was replaced. Check the alignment, then learn again.",
      next: { label: "Check the alignment", to: `${base}/alignment`, primary: true },
    };
  if (state === "failed" || state === "stopped")
    return {
      mark: state === "failed" ? "attention" : "warning",
      text: state === "failed" ? "Learning failed." : "Learning stopped before it finished.",
      next: { label: "Continue learning", to: `${base}/learn`, primary: true },
    };
  if (entries === null)
    return {
      mark: "none",
      text: "Not learned yet.",
      next: { label: "Check the alignment", to: `${base}/alignment`, primary: true },
    };
  const size = counts
    ? `${plural(counts.entries, "entry", "entries")} and ${count(counts.styleRules, "style rule")}`
    : plural(entries, "entry", "entries");
  return {
    mark: state === "done_with_errors" ? "warning" : "done",
    text: pair.fromBook
      ? `${size}, made from a book.`
      : `${size}, learned${when(finishedAt)}${state === "done_with_errors" ? "; some chapters failed" : ""}.`,
    next: null,
  };
}
