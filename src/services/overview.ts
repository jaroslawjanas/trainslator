import type { AppContext } from "../server/context.ts";
import type { ProjectOverview } from "../shared/overview.ts";
import { historyView, loadHistory } from "./history.ts";
import { loadKb } from "./kb.ts";
import { chaptersOverview } from "./translation.ts";

/**
 * Counts for the lists that say where books and pairs stand. Nothing is
 * stored: every number is read from the files, so it is right after an
 * edit. With `bookId`, only that book is counted (for the sidebar).
 */
export async function projectOverview(
  app: AppContext,
  pid: string,
  bookId?: string,
): Promise<ProjectOverview> {
  const out: ProjectOverview = { books: {}, pairs: {} };
  for (const book of await app.projects.books(pid)) {
    if (bookId && book.id !== bookId) continue;
    const { kb } = await loadKb(app, { kind: "book", pid, id: book.id });
    const { totals } = await chaptersOverview(app, pid, book.id);
    // A build is current when it was made from the translation as it is now (edits included).
    let buildCurrent: boolean | null = null;
    if (book.build.builtAt) {
      const lastBuild = (await loadHistory(app, pid, book.id)).builds.at(-1);
      const savedAs = (await historyView(app, pid, book.id)).current?.savedAs ?? null;
      if (lastBuild?.translationId) buildCurrent = lastBuild.translationId === savedAs;
    }
    out.books[book.id] = {
      entries: kb.entries.length,
      openQuestions: kb.entries.filter((e) => e.status === "open").length,
      passages: totals ? totals.ok + totals.edited : 0,
      attention: totals ? totals.flagged + totals.refused : 0,
      pending: totals?.pending ?? 0,
      buildCurrent,
    };
  }
  if (bookId) return out;
  for (const pair of await app.projects.pairs(pid)) {
    const { kb } = await loadKb(app, { kind: "pair", pid, id: pair.id });
    out.pairs[pair.id] = { entries: kb.entries.length, styleRules: kb.styleRules.length };
  }
  return out;
}
