import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadResults } from "../pipeline/phase3.ts";
import type { AppContext } from "../server/context.ts";
import { addUsage, emptyUsage, newId, nowIso } from "../shared/schemas/common.ts";
import { Kb } from "../shared/schemas/kb.ts";
import { PhaseState, type TranslationMode } from "../shared/schemas/project.ts";
import {
  BookHistory,
  ChunkResult,
  Glossary,
  ManualEdits,
  type PassageOrigin,
  type Phase3Plan,
  type SavedBuild,
  type SavedKnowledge,
  type SavedTranslation,
  SavedTranslationContent,
  type SaveReason,
  TocTranslations,
} from "../shared/schemas/translation.ts";
import {
  fileExists,
  listDir,
  readJson,
  readText,
  removePath,
  updateJson,
  writeFileAtomic,
  writeJson,
} from "../store/json.ts";
import { NotFoundError } from "./projects.ts";
import { loadPlan } from "./translation.ts";

/**
 * The book's history: every distinct translation, saved after each
 * translation run, at each build, and before it is replaced (translating the
 * whole book again, restoring another one), plus a copy of every EPUB built.
 */

type Content = Omit<SavedTranslationContent, "schemaVersion" | "id">;
type Info = Omit<SavedTranslation, "id" | "savedAt" | "reason">;

const RedoMarker = z.object({ jobId: z.string() });

function emptyHistory(): BookHistory {
  return { schemaVersion: 1, translations: [], builds: [], knowledgeBases: [] };
}

export async function loadHistory(app: AppContext, pid: string, bookId: string) {
  return (await readJson(app.paths.historyIndex(pid, bookId), BookHistory)) ?? emptyHistory();
}

/** Same passages, edits, title and contents: same hash. */
function contentHash(c: Content): string {
  const units = Object.keys(c.units)
    .sort()
    .map((k) => [k, c.units[k]!.text, c.units[k]!.status]);
  const edits = Object.keys(c.edits)
    .sort()
    .map((k) => [k, c.edits[k]!.text]);
  const toc = c.toc
    ? [
        c.toc.title,
        Object.keys(c.toc.items)
          .sort()
          .map((k) => [k, c.toc!.items[k]]),
      ]
    : null;
  return createHash("sha256")
    .update(JSON.stringify([units, edits, toc]))
    .digest("hex")
    .slice(0, 32);
}

/** The current translation in saved form, or null when nothing is translated. */
async function currentTranslation(
  app: AppContext,
  pid: string,
  bookId: string,
): Promise<{ content: Content; info: Info } | null> {
  const results = await loadResults(app.paths, pid, bookId);
  const edits = (await readJson(app.paths.phase3Edits(pid, bookId), ManualEdits))?.edits ?? {};
  if (results.size === 0 && Object.keys(edits).length === 0) return null;
  const toc = (await readJson(app.paths.phase3Toc(pid, bookId), TocTranslations)) ?? null;
  const glossary = (await readJson(app.paths.phase3Glossary(pid, bookId), Glossary))?.terms ?? [];
  const plan = await loadPlan(app, pid, bookId);

  const origins: PassageOrigin[] = [];
  const originIndex = new Map<string, number>();
  const units: Content["units"] = {};
  const counts = { units: 0, ok: 0, flagged: 0, refused: 0, pending: 0, edited: 0 };
  const models = new Set<string>();
  const modes = new Set<TranslationMode>();
  const reasoning = new Set<string>();
  let usage = emptyUsage();
  // Results from before the mode was recorded also counted other chapters'
  // requests, so their usage can't be added up.
  let usageKnown = true;
  for (const r of [...results.values()].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    usage = addUsage(usage, r.usage);
    if (r.mode === null && r.usage.calls > 0) usageKnown = false;
    const origin = { modelId: r.modelId, mode: r.mode, reasoning: r.reasoning };
    const originKey = JSON.stringify(origin);
    let index = originIndex.get(originKey);
    if (index === undefined) {
      index = origins.length;
      origins.push(origin);
      originIndex.set(originKey, index);
    }
    if (r.modelId) models.add(r.modelId);
    if (r.mode) modes.add(r.mode);
    if (r.reasoning) reasoning.add(r.reasoning);
    for (const { key, ...unit } of r.units) {
      units[key] = { ...unit, origin: index };
      counts.units++;
      counts[unit.status]++;
    }
  }
  counts.edited = Object.keys(edits).length;
  if (plan)
    counts.pending = plan.chunks.reduce(
      (n, c) => n + c.unitKeys.filter((k) => !units[k]).length,
      0,
    );
  const content: Content = { origins, units, edits, toc, glossary };
  const known = app.settings.get().models;
  const label = (id: string) => {
    const m = known.find((x) => x.id === id);
    return m ? m.label || m.modelName : id;
  };
  return {
    content,
    info: {
      contentHash: contentHash(content),
      modes: [...modes],
      models: [...models].map(label),
      reasoning: [...reasoning],
      usage: usageKnown ? usage : emptyUsage(),
      counts,
    },
  };
}

/**
 * Saves the current translation unless the same one is saved already.
 * Returns the id it is saved under, or null when nothing is translated.
 */
export async function saveTranslation(
  app: AppContext,
  pid: string,
  bookId: string,
  reason: SaveReason,
): Promise<string | null> {
  const current = await currentTranslation(app, pid, bookId);
  if (!current) return null;
  let id: string | null = null;
  await updateJson(app.paths.historyIndex(pid, bookId), BookHistory, emptyHistory, async (h) => {
    const same = h.translations.find((t) => t.contentHash === current.info.contentHash);
    if (same) {
      id = same.id;
      return h;
    }
    const newIdValue = newId("tr");
    id = newIdValue;
    await writeJson(app.paths.savedTranslation(pid, bookId, newIdValue), SavedTranslationContent, {
      schemaVersion: 1,
      id: newIdValue,
      ...current.content,
    });
    return {
      ...h,
      translations: [
        ...h.translations,
        { id: newIdValue, savedAt: nowIso(), reason, ...current.info },
      ],
    };
  });
  return id;
}

export async function loadSavedTranslation(
  app: AppContext,
  pid: string,
  bookId: string,
  id: string,
): Promise<SavedTranslationContent> {
  const saved = await readJson(
    app.paths.savedTranslation(pid, bookId, id),
    SavedTranslationContent,
  );
  if (!saved) throw new NotFoundError("Saved translation");
  return saved;
}

/** Changes a saved translation's content; its hash and edit count follow. */
async function updateSaved(
  app: AppContext,
  pid: string,
  bookId: string,
  id: string,
  change: (content: SavedTranslationContent) => SavedTranslationContent,
): Promise<void> {
  await updateJson(app.paths.historyIndex(pid, bookId), BookHistory, emptyHistory, async (h) => {
    if (!h.translations.some((t) => t.id === id)) throw new NotFoundError("Saved translation");
    const content = change(await loadSavedTranslation(app, pid, bookId, id));
    await writeJson(app.paths.savedTranslation(pid, bookId, id), SavedTranslationContent, content);
    return {
      ...h,
      translations: h.translations.map((t) =>
        t.id === id
          ? {
              ...t,
              contentHash: contentHash(content),
              counts: { ...t.counts, edited: Object.keys(content.edits).length },
            }
          : t,
      ),
    };
  });
}

/** Your text for one passage of a saved translation (checked by the caller). */
export function editSavedUnit(
  app: AppContext,
  pid: string,
  bookId: string,
  id: string,
  key: string,
  text: string,
): Promise<void> {
  return updateSaved(app, pid, bookId, id, (c) => ({
    ...c,
    edits: {
      ...c.edits,
      [key]: { text, at: nowIso(), previous: c.edits[key]?.text ?? c.units[key]?.text ?? null },
    },
  }));
}

/** Your texts for several passages of a saved translation at once (checked by the caller). */
export function editSavedUnits(
  app: AppContext,
  pid: string,
  bookId: string,
  id: string,
  texts: Record<string, string>,
): Promise<void> {
  return updateSaved(app, pid, bookId, id, (c) => {
    const edits = { ...c.edits };
    for (const [key, text] of Object.entries(texts))
      edits[key] = {
        text,
        at: nowIso(),
        previous: c.edits[key]?.text ?? c.units[key]?.text ?? null,
      };
    return { ...c, edits };
  });
}

/** Back to the AI's text for one passage of a saved translation. */
export function revertSavedUnit(
  app: AppContext,
  pid: string,
  bookId: string,
  id: string,
  key: string,
): Promise<void> {
  return updateSaved(app, pid, bookId, id, (c) => {
    const { [key]: _removed, ...edits } = c.edits;
    return { ...c, edits };
  });
}

/** The knowledge base's files, and a hash of what they hold. */
async function knowledgeNow(app: AppContext, pid: string, bookId: string) {
  const kbText = await readText(app.paths.bookKb(pid, bookId));
  if (kbText === undefined) return null;
  const overridesText = (await readText(app.paths.bookKbOverrides(pid, bookId))) ?? "";
  const steps = (await listDir(app.paths.phase2Dir(pid, bookId))).filter((n) =>
    /^step\.\d+\.json$/.test(n),
  ).length;
  const hash = createHash("sha256")
    .update(JSON.stringify([kbText, overridesText, steps]))
    .digest("hex")
    .slice(0, 32);
  return { kb: Kb.parse(JSON.parse(kbText)), hash };
}

/**
 * Saves a copy of the book's knowledge base, your own changes to it and
 * phase 2's chapter notes, unless the same copy is saved already.
 */
export async function saveKnowledge(
  app: AppContext,
  pid: string,
  bookId: string,
  reason: SavedKnowledge["reason"],
): Promise<string | null> {
  const now = await knowledgeNow(app, pid, bookId);
  if (!now) return null;
  const book = await app.projects.book(pid, bookId);
  let id: string | null = null;
  await updateJson(app.paths.historyIndex(pid, bookId), BookHistory, emptyHistory, async (h) => {
    const same = h.knowledgeBases.find((k) => k.contentHash === now.hash);
    if (same) {
      id = same.id;
      return h;
    }
    const newIdValue = newId("kb");
    id = newIdValue;
    const dir = app.paths.savedKnowledge(pid, bookId, newIdValue);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(app.paths.bookKb(pid, bookId), path.join(dir, "kb.json"));
    if (await fileExists(app.paths.bookKbOverrides(pid, bookId)))
      await fs.copyFile(
        app.paths.bookKbOverrides(pid, bookId),
        path.join(dir, "kb.overrides.json"),
      );
    if (await fileExists(app.paths.phase2Dir(pid, bookId)))
      await fs.cp(app.paths.phase2Dir(pid, bookId), path.join(dir, "phase2"), { recursive: true });
    const entries = now.kb.entries;
    return {
      ...h,
      knowledgeBases: [
        ...h.knowledgeBases,
        {
          id: newIdValue,
          savedAt: nowIso(),
          reason,
          contentHash: now.hash,
          entries: entries.length,
          open: entries.filter((e) => e.status === "open").length,
          locked: entries.filter((e) => e.status === "locked").length,
          phase2: {
            state: book.phase2.state,
            finishedAt: book.phase2.finishedAt,
            stepsDone: book.phase2.stepsDone,
          },
        },
      ],
    };
  });
  return id;
}

/** Puts a saved knowledge base back, after saving the current one. */
export async function restoreKnowledge(
  app: AppContext,
  pid: string,
  bookId: string,
  id: string,
): Promise<void> {
  const saved = (await loadHistory(app, pid, bookId)).knowledgeBases.find((k) => k.id === id);
  if (!saved) throw new NotFoundError("Saved knowledge base");
  const dir = app.paths.savedKnowledge(pid, bookId, id);
  await saveKnowledge(app, pid, bookId, "restore");
  await removePath(app.paths.phase2Dir(pid, bookId));
  if (await fileExists(path.join(dir, "phase2")))
    await fs.cp(path.join(dir, "phase2"), app.paths.phase2Dir(pid, bookId), { recursive: true });
  await fs.copyFile(path.join(dir, "kb.json"), app.paths.bookKb(pid, bookId));
  if (await fileExists(path.join(dir, "kb.overrides.json")))
    await fs.copyFile(path.join(dir, "kb.overrides.json"), app.paths.bookKbOverrides(pid, bookId));
  else await removePath(app.paths.bookKbOverrides(pid, bookId));
  const book = await app.projects.book(pid, bookId);
  await app.projects.saveBook(pid, {
    ...book,
    phase2: {
      state: PhaseState.catch("done").parse(saved.phase2.state),
      finishedAt: saved.phase2.finishedAt,
      stepsDone: saved.phase2.stepsDone,
    },
  });
}

/** The history for the History page: translations numbered from 1, with their builds. */
export async function historyView(app: AppContext, pid: string, bookId: string) {
  const history = await loadHistory(app, pid, bookId);
  const current = await currentTranslation(app, pid, bookId);
  const hash = current?.info.contentHash;
  const knowledge = await knowledgeNow(app, pid, bookId);
  return {
    knowledgeBases: history.knowledgeBases.map((k, i) => ({ ...k, number: i + 1 })),
    currentKnowledge:
      history.knowledgeBases.find((k) => k.contentHash === knowledge?.hash)?.id ?? null,
    translations: history.translations.map((t, i) => ({
      ...t,
      number: i + 1,
      builds: history.builds.filter((b) => b.translationId === t.id),
    })),
    current: current
      ? {
          savedAs: history.translations.find((t) => t.contentHash === hash)?.id ?? null,
          counts: current.info.counts,
        }
      : null,
  };
}

/**
 * "Translate the whole book again": saves the current translation and clears
 * it. Only once per job, so a resumed job keeps what it translated since.
 */
export async function startOver(
  app: AppContext,
  pid: string,
  bookId: string,
  jobId: string,
): Promise<void> {
  const marker = await readJson(app.paths.redoMarker(pid, bookId), RedoMarker).catch(
    () => undefined,
  );
  if (marker?.jobId === jobId) return;
  await saveTranslation(app, pid, bookId, "redo");
  await removePath(app.paths.phase3ResultsDir(pid, bookId));
  await removePath(app.paths.phase3Edits(pid, bookId));
  await removePath(app.paths.phase3Toc(pid, bookId));
  await removePath(app.paths.phase3Glossary(pid, bookId));
  await writeJson(app.paths.redoMarker(pid, bookId), RedoMarker, { jobId });
}

/**
 * Makes a saved translation the current one, after saving the current one.
 * Passages are placed into the current plan's chunks; a chunk with a passage
 * the saved translation lacks stays untranslated.
 */
export async function restoreTranslation(
  app: AppContext,
  pid: string,
  bookId: string,
  id: string,
  plan: Phase3Plan,
): Promise<void> {
  const saved = await loadSavedTranslation(app, pid, bookId, id);
  const info = (await loadHistory(app, pid, bookId)).translations.find((t) => t.id === id);
  await saveTranslation(app, pid, bookId, "restore");
  const old = await loadResults(app.paths, pid, bookId);
  await removePath(app.paths.phase3ResultsDir(pid, bookId));
  let restored = 0;
  let needAttention = 0;
  for (const chunk of plan.chunks) {
    const units = chunk.unitKeys.map((k) => saved.units[k]);
    if (units.some((u) => !u)) continue;
    const origins = new Set(units.map((u) => u!.origin));
    const origin = origins.size === 1 ? saved.origins[[...origins][0]!] : undefined;
    const previous = old.get(chunk.index);
    await writeJson(app.paths.phase3Result(pid, bookId, chunk.index), ChunkResult, {
      schemaVersion: 1,
      chunkIndex: chunk.index,
      chapterId: chunk.chapterId,
      inputsHash: "restored",
      promptVersion: 0,
      modelId: origin?.modelId ?? "",
      mode: origin?.mode ?? null,
      reasoning: origin?.reasoning ?? null,
      instruction: null,
      finishedAt: info?.savedAt ?? nowIso(),
      usage: emptyUsage(),
      units: chunk.unitKeys.map((key, i) => {
        const { origin: _origin, ...unit } = units[i]!;
        if (unit.status !== "ok") needAttention++;
        return { key, ...unit };
      }),
      history: previous
        ? [...previous.history, { at: previous.finishedAt, units: previous.units }].slice(-10)
        : [],
    });
    restored++;
  }
  if (Object.keys(saved.edits).length > 0)
    await writeJson(app.paths.phase3Edits(pid, bookId), ManualEdits, {
      schemaVersion: 1,
      edits: saved.edits,
    });
  else await removePath(app.paths.phase3Edits(pid, bookId));
  if (saved.toc) await writeJson(app.paths.phase3Toc(pid, bookId), TocTranslations, saved.toc);
  else await removePath(app.paths.phase3Toc(pid, bookId));
  await writeJson(app.paths.phase3Glossary(pid, bookId), Glossary, {
    schemaVersion: 1,
    terms: saved.glossary,
  });
  const book = await app.projects.book(pid, bookId);
  await app.projects.saveBook(pid, {
    ...book,
    phase3:
      restored === 0
        ? { state: "none", finishedAt: null }
        : {
            state: needAttention > 0 ? "done_with_errors" : "done",
            finishedAt: info?.savedAt ?? nowIso(),
          },
  });
}

/** Keeps a copy of a built EPUB, with the translation it was built from. */
export async function recordBuild(
  app: AppContext,
  pid: string,
  bookId: string,
  file: string,
  build: Omit<SavedBuild, "id" | "bytes" | "translationId">,
): Promise<SavedBuild> {
  const translationId = await saveTranslation(app, pid, bookId, "build");
  const id = newId("bd");
  const bytes = await fs.readFile(file);
  await writeFileAtomic(app.paths.savedBuild(pid, bookId, id), bytes);
  const saved: SavedBuild = { ...build, id, bytes: bytes.length, translationId };
  await updateJson(app.paths.historyIndex(pid, bookId), BookHistory, emptyHistory, (h) => ({
    ...h,
    builds: [...h.builds, saved],
  }));
  return saved;
}

export async function savedBuildFile(app: AppContext, pid: string, bookId: string, id: string) {
  const build = (await loadHistory(app, pid, bookId)).builds.find((b) => b.id === id);
  if (!build) throw new NotFoundError("Build");
  return { build, data: await fs.readFile(app.paths.savedBuild(pid, bookId, id)) };
}
