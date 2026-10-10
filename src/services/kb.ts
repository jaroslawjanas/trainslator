import { slugId, uniqueId } from "../kb/model.ts";
import {
  applyOverrides,
  deleteEntry,
  lockEntry,
  setStyleRule,
  unlockEntry,
} from "../kb/overrides.ts";
import { promptIds, renderKb } from "../kb/render.ts";
import { estimateTokens } from "../llm/tokens.ts";
import { latestSnapshot } from "../pipeline/phase2.ts";
import type { AppContext } from "../server/context.ts";
import { nowIso } from "../shared/schemas/common.ts";
import {
  emptyKb,
  emptyOverrides,
  Kb,
  type KbEntry,
  KbOverrides,
  type StyleRule,
} from "../shared/schemas/kb.ts";
import { readJson, withFileLock, writeJson } from "../store/json.ts";
import { NotFoundError, UserError } from "./projects.ts";

export interface KbScope {
  kind: "pair" | "book";
  pid: string;
  id: string;
}

function files(app: AppContext, scope: KbScope) {
  return scope.kind === "pair"
    ? {
        kb: app.paths.pairKb(scope.pid, scope.id),
        overrides: app.paths.pairKbOverrides(scope.pid, scope.id),
      }
    : {
        kb: app.paths.bookKb(scope.pid, scope.id),
        overrides: app.paths.bookKbOverrides(scope.pid, scope.id),
      };
}

async function title(app: AppContext, scope: KbScope): Promise<string> {
  return scope.kind === "pair"
    ? (await app.projects.pair(scope.pid, scope.id)).title
    : (await app.projects.book(scope.pid, scope.id)).title;
}

export async function loadKb(
  app: AppContext,
  scope: KbScope,
): Promise<{ kb: Kb; overrides: KbOverrides }> {
  const f = files(app, scope);
  const kb = (await readJson(f.kb, Kb)) ?? emptyKb(scope.kind, await title(app, scope));
  const overrides = (await readJson(f.overrides, KbOverrides)) ?? emptyOverrides();
  return { kb, overrides };
}

/** Saves an overrides change and applies it to the stored KB, under both files' locks. */
async function change(
  app: AppContext,
  scope: KbScope,
  fn: (o: KbOverrides, kb: Kb) => KbOverrides,
): Promise<Kb> {
  const f = files(app, scope);
  return withFileLock(f.overrides, () =>
    withFileLock(f.kb, async () => {
      const { kb, overrides } = await loadKb(app, scope);
      const next = fn(overrides, kb);
      await writeJson(f.overrides, KbOverrides, next);
      return writeJson(f.kb, Kb, applyOverrides(kb, next));
    }),
  );
}

export function assertNotBusy(app: AppContext, scope: KbScope): void {
  const active = app.runner.activeFor(scope.id);
  if (active && (active.type === "phase1" || active.type === "phase2")) {
    throw new UserError(
      "A phase is running and writing this knowledge base. Edit it after the phase finishes or is paused.",
    );
  }
}

export async function editEntry(app: AppContext, scope: KbScope, entry: KbEntry): Promise<Kb> {
  assertNotBusy(app, scope);
  return change(app, scope, (o, kb) => {
    if (!kb.entries.some((e) => e.id === entry.id) && !o.entries[entry.id])
      throw new NotFoundError("Entry");
    return lockEntry(o, {
      ...entry,
      status: entry.status === "open" && !entry.target ? "open" : "locked",
      origin: entry.origin,
    });
  });
}

/**
 * Saves an entry without locking it: your answer goes into the knowledge
 * base (an open question with a translation is settled), but later runs may
 * still change the entry. For a book it also goes into phase 2's latest
 * snapshot, so reading on or reviewing again starts from it.
 */
export async function saveUnlocked(app: AppContext, scope: KbScope, entry: KbEntry): Promise<Kb> {
  assertNotBusy(app, scope);
  const f = files(app, scope);
  return withFileLock(f.overrides, () =>
    withFileLock(f.kb, async () => {
      const { kb, overrides } = await loadKb(app, scope);
      if (overrides.entries[entry.id])
        throw new UserError("This entry is locked. Unlock it first, or save it locked.");
      if (!kb.entries.some((e) => e.id === entry.id)) throw new NotFoundError("Entry");
      const stillOpen = entry.status === "open" && !entry.target;
      const saved: KbEntry = {
        ...entry,
        status: stillOpen ? "open" : "auto",
        question: stillOpen ? entry.question : null,
        updatedAt: nowIso(),
      };
      const put = (k: Kb): Kb => ({
        ...k,
        entries: k.entries.map((e) => (e.id === saved.id ? saved : e)),
      });
      if (scope.kind === "book") {
        const file = await latestSnapshot(app, scope.pid, scope.id);
        const snapshot = file ? await readJson(file, Kb).catch(() => undefined) : undefined;
        if (file && snapshot?.entries.some((e) => e.id === saved.id))
          await writeJson(file, Kb, put(snapshot));
      }
      return writeJson(f.kb, Kb, put(kb));
    }),
  );
}

export async function addEntry(
  app: AppContext,
  scope: KbScope,
  draft: Omit<KbEntry, "id" | "updatedAt" | "origin" | "refs">,
): Promise<Kb> {
  assertNotBusy(app, scope);
  return change(app, scope, (o, kb) => {
    const taken = new Set([...kb.entries.map((e) => e.id), ...Object.keys(o.entries)]);
    const entry: KbEntry = {
      ...draft,
      id: uniqueId(slugId("u", draft.source), taken),
      refs: [],
      origin: "user",
      updatedAt: nowIso(),
      status: "locked",
    };
    return lockEntry(o, entry);
  });
}

export async function unlock(app: AppContext, scope: KbScope, id: string): Promise<Kb> {
  assertNotBusy(app, scope);
  const f = files(app, scope);
  return withFileLock(f.overrides, () =>
    withFileLock(f.kb, async () => {
      const { kb, overrides } = await loadKb(app, scope);
      const next = unlockEntry(overrides, id);
      await writeJson(f.overrides, KbOverrides, next);
      return writeJson(f.kb, Kb, {
        ...kb,
        entries: kb.entries.map((e) =>
          e.id === id ? { ...e, status: e.status === "locked" ? "auto" : e.status } : e,
        ),
      });
    }),
  );
}

export async function removeEntry(app: AppContext, scope: KbScope, id: string): Promise<Kb> {
  assertNotBusy(app, scope);
  return change(app, scope, (o, kb) => {
    const entry = kb.entries.find((e) => e.id === id) ?? o.entries[id]?.entry;
    if (!entry) throw new NotFoundError("Entry");
    return deleteEntry(o, entry);
  });
}

/** Answers an open question; allowed while phase 2 runs (it reads your answers between chapters). */
export async function answerQuestion(
  app: AppContext,
  scope: KbScope,
  id: string,
  answer: {
    target: string | null;
    note: string | null;
    attributes: { key: string; value: string }[] | null;
  },
): Promise<Kb> {
  return change(app, scope, (o, kb) => {
    const entry = kb.entries.find((e) => e.id === id) ?? o.entries[id]?.entry;
    if (!entry) throw new NotFoundError("Entry");
    return lockEntry(o, {
      ...entry,
      target: answer.target ?? entry.target,
      note: answer.note ?? entry.note,
      attributes: answer.attributes ?? entry.attributes,
      question: null,
      status: "locked",
    });
  });
}

export async function saveStyleRule(app: AppContext, scope: KbScope, rule: StyleRule): Promise<Kb> {
  assertNotBusy(app, scope);
  return change(app, scope, (o) => setStyleRule(o, rule, rule.id));
}

export async function addStyleRule(app: AppContext, scope: KbScope, text: string): Promise<Kb> {
  assertNotBusy(app, scope);
  return change(app, scope, (o, kb) => {
    const taken = new Set([...kb.styleRules.map((r) => r.id), ...Object.keys(o.styleRules)]);
    const id = uniqueId(slugId("ur", text), taken);
    return setStyleRule(o, { id, rule: text.trim(), examples: [], status: "locked" }, id);
  });
}

export async function removeStyleRule(app: AppContext, scope: KbScope, id: string): Promise<Kb> {
  assertNotBusy(app, scope);
  return change(app, scope, (o) => setStyleRule(o, null, id));
}

export async function preview(
  app: AppContext,
  scope: KbScope,
): Promise<{ text: string; tokens: number }> {
  const { kb } = await loadKb(app, scope);
  const text =
    scope.kind === "book" ? renderKb(kb, { ids: promptIds(kb), markLocked: true }) : renderKb(kb);
  return { text, tokens: estimateTokens(text) };
}
