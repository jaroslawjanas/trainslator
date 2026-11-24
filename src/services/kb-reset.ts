import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyOverrides } from "../kb/overrides.ts";
import { resetBookKnowledge } from "../pipeline/phase2.ts";
import type { AppContext } from "../server/context.ts";
import { newId, nowIso } from "../shared/schemas/common.ts";
import { emptyKb, emptyOverrides, Kb, KbOverrides } from "../shared/schemas/kb.ts";
import { PairHistory, type PairSavedKnowledge, PhaseState } from "../shared/schemas/project.ts";
import {
  fileExists,
  readJson,
  readText,
  removePath,
  updateJson,
  withFileLock,
  writeJson,
} from "../store/json.ts";
import type { KbScope } from "./kb.ts";
import { NotFoundError, UserError } from "./projects.ts";

/**
 * Starting a knowledge base over: a copy is saved first (a book's in its
 * History, a pair's in its own list of earlier versions), then the
 * knowledge base is emptied, keeping your own changes unless you drop them.
 * The next run of its phase asks the models anew instead of repeating their
 * saved answers, so it really is made again.
 */

function emptyPairHistory(): PairHistory {
  return { schemaVersion: 1, knowledgeBases: [] };
}

export async function loadPairHistory(
  app: AppContext,
  pid: string,
  pairId: string,
): Promise<PairHistory> {
  return (
    (await readJson(app.paths.pairHistoryIndex(pid, pairId), PairHistory)) ?? emptyPairHistory()
  );
}

/** The pair's knowledge base as it is, and a hash of what it holds; null if it has none. */
async function pairKnowledgeNow(app: AppContext, pid: string, pairId: string) {
  const kbText = await readText(app.paths.pairKb(pid, pairId));
  if (kbText === undefined) return null;
  const overridesText = (await readText(app.paths.pairKbOverrides(pid, pairId))) ?? "";
  const hash = createHash("sha256")
    .update(JSON.stringify([kbText, overridesText]))
    .digest("hex")
    .slice(0, 32);
  return { kb: Kb.parse(JSON.parse(kbText)), hash };
}

/**
 * Saves a copy of the pair's knowledge base, your own changes to it and
 * phase 1's saved work, unless the same copy is saved already.
 */
export async function savePairKnowledge(
  app: AppContext,
  pid: string,
  pairId: string,
  reason: PairSavedKnowledge["reason"],
): Promise<string | null> {
  const now = await pairKnowledgeNow(app, pid, pairId);
  if (!now) return null;
  const pair = await app.projects.pair(pid, pairId);
  let id: string | null = null;
  await updateJson(
    app.paths.pairHistoryIndex(pid, pairId),
    PairHistory,
    emptyPairHistory,
    async (h) => {
      const same = h.knowledgeBases.find((k) => k.contentHash === now.hash);
      if (same) {
        id = same.id;
        return h;
      }
      const saved = newId("kb");
      id = saved;
      const dir = app.paths.pairSavedKnowledge(pid, pairId, saved);
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(app.paths.pairKb(pid, pairId), path.join(dir, "kb.json"));
      if (await fileExists(app.paths.pairKbOverrides(pid, pairId)))
        await fs.copyFile(
          app.paths.pairKbOverrides(pid, pairId),
          path.join(dir, "kb.overrides.json"),
        );
      if (await fileExists(app.paths.phase1Dir(pid, pairId)))
        await fs.cp(app.paths.phase1Dir(pid, pairId), path.join(dir, "phase1"), {
          recursive: true,
        });
      const entries = now.kb.entries;
      return {
        ...h,
        knowledgeBases: [
          ...h.knowledgeBases,
          {
            id: saved,
            savedAt: nowIso(),
            reason,
            contentHash: now.hash,
            entries: entries.length,
            open: entries.filter((e) => e.status === "open").length,
            locked: entries.filter((e) => e.status === "locked").length,
            phase1: { ...pair.phase1 },
          },
        ],
      };
    },
  );
  return id;
}

/** The pair's saved knowledge bases, numbered from 1, and which one is the current. */
export async function pairKnowledgeView(app: AppContext, pid: string, pairId: string) {
  await app.projects.pair(pid, pairId);
  const history = await loadPairHistory(app, pid, pairId);
  const now = await pairKnowledgeNow(app, pid, pairId);
  return {
    knowledgeBases: history.knowledgeBases.map((k, i) => ({ ...k, number: i + 1 })),
    current: history.knowledgeBases.find((k) => k.contentHash === now?.hash)?.id ?? null,
  };
}

function assertIdle(app: AppContext, scope: KbScope): void {
  if (app.runner.activeFor(scope.id))
    throw new UserError(
      `A job is running for this ${scope.kind}. Wait for it to finish, or stop it, first.`,
    );
}

/** Both knowledge base files, locked the way every edit locks them. */
function withKbLocks<T>(app: AppContext, scope: KbScope, fn: () => Promise<T>): Promise<T> {
  const kb =
    scope.kind === "pair"
      ? app.paths.pairKb(scope.pid, scope.id)
      : app.paths.bookKb(scope.pid, scope.id);
  const overrides =
    scope.kind === "pair"
      ? app.paths.pairKbOverrides(scope.pid, scope.id)
      : app.paths.bookKbOverrides(scope.pid, scope.id);
  return withFileLock(overrides, () => withFileLock(kb, fn));
}

/** Puts a saved knowledge base of the pair back, after saving the current one. */
export async function restorePairKnowledge(
  app: AppContext,
  pid: string,
  pairId: string,
  id: string,
): Promise<void> {
  const scope: KbScope = { kind: "pair", pid, id: pairId };
  assertIdle(app, scope);
  const saved = (await loadPairHistory(app, pid, pairId)).knowledgeBases.find((k) => k.id === id);
  if (!saved) throw new NotFoundError("Saved knowledge base");
  const dir = app.paths.pairSavedKnowledge(pid, pairId, id);
  await withKbLocks(app, scope, async () => {
    await savePairKnowledge(app, pid, pairId, "restore");
    await removePath(app.paths.phase1Dir(pid, pairId));
    if (await fileExists(path.join(dir, "phase1")))
      await fs.cp(path.join(dir, "phase1"), app.paths.phase1Dir(pid, pairId), { recursive: true });
    await fs.copyFile(path.join(dir, "kb.json"), app.paths.pairKb(pid, pairId));
    if (await fileExists(path.join(dir, "kb.overrides.json")))
      await fs.copyFile(
        path.join(dir, "kb.overrides.json"),
        app.paths.pairKbOverrides(pid, pairId),
      );
    else await removePath(app.paths.pairKbOverrides(pid, pairId));
  });
  const pair = await app.projects.pair(pid, pairId);
  await app.projects.savePair(pid, {
    ...pair,
    phase1: {
      state: PhaseState.catch("done").parse(saved.phase1.state),
      finishedAt: saved.phase1.finishedAt,
      entries: saved.phase1.entries,
    },
    askAnew: false,
  });
}

/**
 * Empties the knowledge base of a pair or book after saving a copy. Your own
 * changes stay unless `dropOwn`. The phase that builds it goes back to "not
 * run yet", and its next run asks the models anew.
 */
export async function clearKnowledge(
  app: AppContext,
  scope: KbScope,
  options: { dropOwn: boolean },
): Promise<void> {
  assertIdle(app, scope);
  const { pid, id } = scope;
  if (scope.kind === "book") {
    await withKbLocks(app, scope, () =>
      resetBookKnowledge(app, pid, id, { reason: "clear", dropOwn: options.dropOwn }),
    );
    const book = await app.projects.book(pid, id);
    await app.projects.saveBook(pid, {
      ...book,
      phase2: { state: "none", finishedAt: null, stepsDone: 0 },
      askAnew: true,
    });
    return;
  }

  const project = await app.projects.get(pid);
  const pair = await app.projects.pair(pid, id);
  await withKbLocks(app, scope, async () => {
    await savePairKnowledge(app, pid, id, "clear");
    if (options.dropOwn) await removePath(app.paths.pairKbOverrides(pid, id));
    // Saved chapter reads and merge decisions would rebuild the same knowledge base.
    await removePath(app.paths.phase1Dir(pid, id));
    const overrides =
      (await readJson(app.paths.pairKbOverrides(pid, id), KbOverrides)) ?? emptyOverrides();
    const kb = applyOverrides(emptyKb("pair", pair.title), overrides, project.sourceLang);
    // A pair with nothing in it isn't offered to books at all.
    if (kb.entries.length + kb.styleRules.length > 0)
      await writeJson(app.paths.pairKb(pid, id), Kb, kb);
    else await removePath(app.paths.pairKb(pid, id));
  });
  await app.projects.savePair(pid, {
    ...pair,
    phase1: { state: "none", finishedAt: null, entries: null },
    askAnew: true,
  });
}
