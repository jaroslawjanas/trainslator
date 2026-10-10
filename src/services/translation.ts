import { stripPlaceholders } from "../epub/blocks.ts";
import { loadResults } from "../pipeline/phase3.ts";
import { checkUnitTranslation } from "../pipeline/validate.ts";
import type { AppContext } from "../server/context.ts";
import { unicodeScriptsFor } from "../shared/languages.ts";
import { nowIso } from "../shared/schemas/common.ts";
import {
  ChunkResult,
  DocUnits,
  Glossary,
  ManualEdits,
  Phase3Plan,
  TocTranslations,
  type TransUnit,
} from "../shared/schemas/translation.ts";
import { listDir, readJson, updateJson, writeJson } from "../store/json.ts";
import { NotFoundError, UserError } from "./projects.ts";

/** Unit keys contain dots; URLs use underscores instead. */
export function encodeUnitKey(key: string): string {
  return key.replaceAll(".", "_");
}
export function decodeUnitKey(value: string): string {
  return value.replaceAll("_", ".");
}

export async function loadPlan(
  app: AppContext,
  pid: string,
  bookId: string,
): Promise<Phase3Plan | null> {
  return (
    (await readJson(app.paths.phase3Plan(pid, bookId), Phase3Plan).catch(() => undefined)) ?? null
  );
}

export async function loadAllUnits(
  app: AppContext,
  pid: string,
  bookId: string,
): Promise<Map<string, TransUnit>> {
  const units = new Map<string, TransUnit>();
  const dir = app.paths.phase3Units(pid, bookId, 0).replace(/[\\/]d0\.json$/, "");
  for (const name of await listDir(dir)) {
    const m = /^d(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = await readJson(app.paths.phase3Units(pid, bookId, Number(m[1])), DocUnits).catch(
      () => undefined,
    );
    for (const u of file?.units ?? []) units.set(u.key, u);
  }
  return units;
}

async function loadEdits(app: AppContext, pid: string, bookId: string) {
  return (
    (await readJson(app.paths.phase3Edits(pid, bookId), ManualEdits).catch(() => undefined))
      ?.edits ?? {}
  );
}

type UnitState = "ok" | "flagged" | "refused" | "pending" | "edited";

export async function chaptersOverview(app: AppContext, pid: string, bookId: string) {
  const plan = await loadPlan(app, pid, bookId);
  if (!plan) return { chapters: [], totals: null };
  const results = await loadResults(app.paths, pid, bookId);
  const edits = await loadEdits(app, pid, bookId);
  const totals = { units: 0, ok: 0, flagged: 0, refused: 0, pending: 0, edited: 0 };
  const chapters = plan.chapters.map((ch) => {
    const counts = { units: 0, ok: 0, flagged: 0, refused: 0, pending: 0, edited: 0 };
    for (const ci of ch.chunks) {
      const chunk = plan.chunks[ci]!;
      const result = results.get(ci);
      const byKey = new Map(result?.units.map((u) => [u.key, u]) ?? []);
      for (const key of chunk.unitKeys) {
        counts.units++;
        const r = byKey.get(key);
        let state: UnitState;
        if (edits[key]) state = "edited";
        else if (!r) state = "pending";
        else state = r.status;
        counts[state]++;
      }
    }
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += counts[k];
    return { id: ch.id, title: ch.title, chunks: ch.chunks.length, ...counts };
  });
  return { chapters, totals };
}

export async function chapterUnits(
  app: AppContext,
  pid: string,
  bookId: string,
  chapterId: string,
) {
  const plan = await loadPlan(app, pid, bookId);
  const chapter = plan?.chapters.find((c) => c.id === chapterId);
  if (!plan || !chapter) throw new NotFoundError("Chapter");
  const units = await loadAllUnits(app, pid, bookId);
  const results = await loadResults(app.paths, pid, bookId);
  const edits = await loadEdits(app, pid, bookId);
  const out = [];
  for (const ci of chapter.chunks) {
    const chunk = plan.chunks[ci]!;
    const result = results.get(ci);
    const byKey = new Map(result?.units.map((u) => [u.key, u]) ?? []);
    for (const key of chunk.unitKeys) {
      const u = units.get(key);
      if (!u) continue;
      const r = byKey.get(key);
      const edit = edits[key];
      out.push({
        key,
        urlKey: encodeUnitKey(key),
        chunkIndex: ci,
        role: u.role,
        kind: u.kind,
        source: u.text,
        placeholders: u.placeholders.map((p) => ({
          n: p.n,
          kind: p.kind,
          label: p.label,
          required: p.required,
        })),
        translation: edit?.text ?? r?.text ?? null,
        aiTranslation: r?.text ?? null,
        status: edit ? ("edited" as const) : r ? r.status : ("pending" as const),
        warnings: r?.warnings ?? [],
        errors: edit ? [] : (r?.errors ?? []),
        instruction: result?.instruction ?? null,
      });
    }
  }
  return { chapter: { id: chapter.id, title: chapter.title }, units: out };
}

async function unitAndScripts(app: AppContext, pid: string, bookId: string, key: string) {
  const units = await loadAllUnits(app, pid, bookId);
  const unit = units.get(key);
  if (!unit) throw new NotFoundError("Unit");
  const project = await app.projects.get(pid);
  return { unit, scripts: unicodeScriptsFor(project.targetScript) };
}

/** Saves your own translation of a unit; placeholders must be valid. */
export async function saveManualEdit(
  app: AppContext,
  pid: string,
  bookId: string,
  key: string,
  text: string,
): Promise<void> {
  const { unit, scripts } = await unitAndScripts(app, pid, bookId, key);
  const check = checkUnitTranslation(unit, text, { targetScripts: scripts, ratio: 1 });
  const blocking = check.errors.filter(
    (e) => !e.startsWith("contains Markdown") && !e.startsWith("is wrapped in quotation"),
  );
  if (blocking.length > 0) throw new UserError(`The text can't be used: ${blocking.join("; ")}.`);
  const results = await loadResults(app.paths, pid, bookId);
  const previous =
    [...results.values()].flatMap((r) => r.units).find((u) => u.key === key)?.text ?? null;
  await updateJson(
    app.paths.phase3Edits(pid, bookId),
    ManualEdits,
    () => ({ schemaVersion: 1 as const, edits: {} }),
    (m) => ({
      ...m,
      edits: { ...m.edits, [key]: { text, at: nowIso(), previous } },
    }),
  );
}

export async function removeManualEdit(
  app: AppContext,
  pid: string,
  bookId: string,
  key: string,
): Promise<void> {
  await updateJson(
    app.paths.phase3Edits(pid, bookId),
    ManualEdits,
    () => ({ schemaVersion: 1 as const, edits: {} }),
    (m) => {
      const { [key]: _removed, ...rest } = m.edits;
      return { ...m, edits: rest };
    },
  );
}

/** Accepts a flagged unit's text as it is (only when it has no errors, just warnings). */
export async function acceptUnit(
  app: AppContext,
  pid: string,
  bookId: string,
  key: string,
): Promise<void> {
  const { unit, scripts } = await unitAndScripts(app, pid, bookId, key);
  const results = await loadResults(app.paths, pid, bookId);
  const result = [...results.values()].find((r) => r.units.some((u) => u.key === key));
  const current = result?.units.find((u) => u.key === key);
  if (!result || !current?.text)
    throw new UserError("There is no translation to accept; edit or re-translate it.");
  const errors = checkUnitTranslation(unit, current.text, {
    targetScripts: scripts,
    ratio: 1,
  }).errors;
  if (errors.length > 0)
    throw new UserError(`It can't be accepted as is: ${errors.join("; ")}. Edit it instead.`);
  await updateJson(
    app.paths.phase3Result(pid, bookId, result.chunkIndex),
    ChunkResult,
    () => result,
    (r) => ({
      ...r,
      units: r.units.map((u) => (u.key === key ? { ...u, status: "ok" as const, errors: [] } : u)),
    }),
  );
}

export async function glossary(app: AppContext, pid: string, bookId: string) {
  return (
    (await readJson(app.paths.phase3Glossary(pid, bookId), Glossary).catch(() => undefined)) ?? {
      schemaVersion: 1,
      terms: [],
    }
  );
}

export async function tocView(app: AppContext, pid: string, bookId: string) {
  const plan = await loadPlan(app, pid, bookId);
  const toc = await readJson(app.paths.phase3Toc(pid, bookId), TocTranslations).catch(
    () => undefined,
  );
  const units = await loadAllUnits(app, pid, bookId);
  const epub = await app.books.open(app.paths.bookEpub(pid, bookId));
  return {
    title: epub.title,
    translatedTitle: toc?.title ?? null,
    items: (plan?.tocUnitKeys ?? []).map((key) => ({
      key,
      file: units.get(key)?.file ?? "",
      source: stripPlaceholders(units.get(key)?.text ?? ""),
      translation: toc?.items[key] ?? null,
      origin: toc?.sources[key] ?? null,
    })),
  };
}

export async function saveToc(
  app: AppContext,
  pid: string,
  bookId: string,
  title: string | null,
  items: Record<string, string>,
) {
  const plan = await loadPlan(app, pid, bookId);
  const allowed = new Set(plan?.tocUnitKeys ?? []);
  for (const key of Object.keys(items))
    if (!allowed.has(key)) throw new UserError("Unknown table-of-contents item.");
  const current = await readJson(app.paths.phase3Toc(pid, bookId), TocTranslations).catch(
    () => undefined,
  );
  const sources = { ...(current?.sources ?? {}) };
  for (const key of Object.keys(items)) sources[key] = "edited";
  await writeJson(app.paths.phase3Toc(pid, bookId), TocTranslations, {
    schemaVersion: 1,
    title: title ?? current?.title ?? null,
    items: { ...(current?.items ?? {}), ...items },
    sources,
    finishedAt: nowIso(),
  });
}
