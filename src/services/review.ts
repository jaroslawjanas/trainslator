import { stripPlaceholders } from "../epub/blocks.ts";
import { callStructured } from "../llm/call.ts";
import { estimateTokens } from "../llm/tokens.ts";
import { loadResults } from "../pipeline/phase3.ts";
import { bookKnowledge } from "../pipeline/phase3-job.ts";
import { checkUnitTranslation, languageChecks } from "../pipeline/validate.ts";
import { FRAGMENT_END, FRAGMENT_START, RewriteOutput, rewriteBlocks } from "../prompts/rewrite.ts";
import type { AppContext } from "../server/context.ts";
import { unicodeScriptsFor } from "../shared/languages.ts";
import { nowIso } from "../shared/schemas/common.ts";
import type { UnitStatus } from "../shared/schemas/translation.ts";
import { ManualEdits } from "../shared/schemas/translation.ts";
import { findMatches, type MatchOptions } from "../shared/search.ts";
import { updateJson } from "../store/json.ts";
import {
  editSavedUnit,
  editSavedUnits,
  loadSavedTranslation,
  revertSavedUnit,
  saveTranslation,
} from "./history.ts";
import { NotFoundError, UserError } from "./projects.ts";
import {
  checkOwnText,
  encodeUnitKey,
  loadAllUnits,
  loadEdits,
  loadPlan,
  removeManualEdit,
  saveManualEdit,
} from "./translation.ts";

/**
 * Review: up to three versions of the book side by side, passage by passage
 * (the current translation and saved ones). Any version's passage can be
 * replaced by another version's, edited by hand, or rewritten by a model.
 */

/** "current", or a saved translation's id. */
export const CURRENT = "current";

export interface VersionCell {
  text: string | null;
  status: UnitStatus | "pending" | "edited";
  /** Your own text, not the AI's. */
  edited: boolean;
}

type Cells = (key: string) => VersionCell;

const PENDING: VersionCell = { text: null, status: "pending", edited: false };

async function versionCells(
  app: AppContext,
  pid: string,
  bookId: string,
  version: string,
): Promise<Cells> {
  if (version === CURRENT) {
    const results = await loadResults(app.paths, pid, bookId);
    const byKey = new Map([...results.values()].flatMap((r) => r.units.map((u) => [u.key, u])));
    const edits = await loadEdits(app, pid, bookId);
    return (key) => {
      if (edits[key]) return { text: edits[key].text, status: "edited", edited: true };
      const r = byKey.get(key);
      return r ? { text: r.text, status: r.status, edited: false } : PENDING;
    };
  }
  const saved = await loadSavedTranslation(app, pid, bookId, version);
  return (key) => {
    if (saved.edits[key]) return { text: saved.edits[key].text, status: "edited", edited: true };
    const u = saved.units[key];
    return u ? { text: u.text, status: u.status, edited: false } : PENDING;
  };
}

/** The unit keys of a chapter, in reading order. */
async function chapterKeys(app: AppContext, pid: string, bookId: string, chapterId: string) {
  const plan = await loadPlan(app, pid, bookId);
  const chapter = plan?.chapters.find((c) => c.id === chapterId);
  if (!plan || !chapter) throw new NotFoundError("Chapter");
  return chapter.chunks.flatMap((i) => plan.chunks[i]?.unitKeys ?? []);
}

/**
 * The chapters with passages, each with how many of its passages differ
 * between the versions shown (null with fewer than two versions).
 */
export async function reviewChapters(
  app: AppContext,
  pid: string,
  bookId: string,
  versions: string[],
) {
  const plan = await loadPlan(app, pid, bookId);
  if (!plan) return { chapters: [] };
  const cells =
    versions.length > 1
      ? await Promise.all(versions.map((v) => versionCells(app, pid, bookId, v)))
      : [];
  return {
    chapters: plan.chapters
      .map((ch) => {
        const keys = ch.chunks.flatMap((i) => plan.chunks[i]?.unitKeys ?? []);
        const different =
          cells.length > 1
            ? keys.filter((k) => {
                const texts = cells.map((c) => c(k).text);
                return texts.some((t) => t !== texts[0]);
              }).length
            : null;
        return { id: ch.id, title: ch.title, units: keys.length, different };
      })
      .filter((c) => c.units > 0),
  };
}

/** The original, as a "version" to search. */
export const SOURCE = "source";

/** Most results returned for one search. */
const MAX_RESULTS = 300;

/** A little text on each side of the first match. */
function snippet(text: string, match: { start: number; end: number }) {
  const from = Math.max(0, match.start - 60);
  const to = Math.min(text.length, match.end + 90);
  return {
    before: `${from > 0 ? "…" : ""}${text.slice(from, match.start)}`,
    match: text.slice(match.start, match.end),
    after: `${text.slice(match.end, to)}${to < text.length ? "…" : ""}`,
  };
}

/**
 * Finds a text in the passages of the given versions ("source" for the
 * original), ignoring case and accents: in one chapter, or the whole book in
 * reading order. One result per passage and version.
 */
export async function searchReview(
  app: AppContext,
  pid: string,
  bookId: string,
  query: string,
  versions: string[],
  chapterId: string | null,
  options: MatchOptions = {},
) {
  const plan = await loadPlan(app, pid, bookId);
  if (!plan) return { results: [], total: 0 };
  const units = await loadAllUnits(app, pid, bookId);
  const cells = new Map(
    await Promise.all(
      versions
        .filter((v) => v !== SOURCE)
        .map(async (v) => [v, await versionCells(app, pid, bookId, v)] as const),
    ),
  );
  const results = [];
  let total = 0;
  for (const chapter of plan.chapters) {
    if (chapterId && chapter.id !== chapterId) continue;
    for (const key of chapter.chunks.flatMap((i) => plan.chunks[i]?.unitKeys ?? [])) {
      const unit = units.get(key);
      if (!unit) continue;
      for (const version of versions) {
        const raw = version === SOURCE ? unit.text : cells.get(version)?.(key).text;
        if (!raw) continue;
        const text = stripPlaceholders(raw);
        const matches = findMatches(text, query, options);
        if (matches.length === 0) continue;
        total++;
        if (results.length < MAX_RESULTS)
          results.push({
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            key,
            version,
            matches: matches.length,
            ...snippet(text, matches[0]!),
          });
      }
    }
  }
  return { results, total };
}

/** Formatting placeholders, which a replacement never touches. */
const TAG_SPLIT = /(<\/?g\d+>|<x\d+\/>)/;
const TAG_TEST = /<\/?g\d+>|<x\d+\/>/;

/**
 * Replaces the query in the text between formatting tags; the tags stay as
 * they are. `skipped` counts matches that cross a tag, which are left alone.
 */
export function replaceInText(
  raw: string,
  query: string,
  replacement: string,
  options: MatchOptions,
): { text: string; count: number; skipped: number } {
  let count = 0;
  const parts = raw.split(TAG_SPLIT).map((part, i) => {
    if (i % 2 === 1) return part;
    const matches = findMatches(part, query, options);
    if (matches.length === 0) return part;
    count += matches.length;
    let out = "";
    let pos = 0;
    for (const m of matches) {
      out += part.slice(pos, m.start) + replacement;
      pos = m.end;
    }
    return out + part.slice(pos);
  });
  const all = findMatches(stripPlaceholders(raw), query, options).length;
  return { text: parts.join(""), count, skipped: Math.max(0, all - count) };
}

export interface ReplaceRequest {
  query: string;
  replacement: string;
  /** Versions to change; the original ("source") never is. */
  versions: string[];
  /** One chapter, or null for the whole book. */
  chapterId: string | null;
  /** One passage only (the "Replace" button), or null for all. */
  key: string | null;
  options: MatchOptions;
  /** Count what would change, without changing anything. */
  dryRun: boolean;
}

/**
 * Replaces a text in the translations: in one passage, one chapter or the
 * whole book. Before the current translation changes it is saved in History,
 * so the replacement can be undone by restoring it.
 */
export async function replaceInReview(
  app: AppContext,
  pid: string,
  bookId: string,
  req: ReplaceRequest,
): Promise<{ passages: number; replaced: number; skipped: number }> {
  const versions = req.versions.filter((v) => v !== SOURCE);
  if (versions.length === 0)
    throw new UserError("Choose a translation to replace in; the original isn't changed.");
  if (TAG_TEST.test(req.replacement))
    throw new UserError("The replacement can't contain formatting tags.");
  const plan = await loadPlan(app, pid, bookId);
  if (!plan) throw new UserError("Nothing is translated yet.");
  const keys = req.key
    ? [req.key]
    : plan.chapters
        .filter((c) => !req.chapterId || c.id === req.chapterId)
        .flatMap((c) => c.chunks.flatMap((i) => plan.chunks[i]?.unitKeys ?? []));

  let passages = 0;
  let replaced = 0;
  let skipped = 0;
  const changes = new Map<string, Record<string, { text: string; previous: string }>>();
  for (const version of versions) {
    const cells = await versionCells(app, pid, bookId, version);
    const changed: Record<string, { text: string; previous: string }> = {};
    for (const key of keys) {
      const raw = cells(key).text;
      if (!raw) continue;
      const result = replaceInText(raw, req.query, req.replacement, req.options);
      skipped += result.skipped;
      if (result.count === 0) continue;
      passages++;
      replaced += result.count;
      changed[key] = { text: result.text, previous: raw };
    }
    if (Object.keys(changed).length > 0) changes.set(version, changed);
  }
  if (req.dryRun) return { passages, replaced, skipped };

  for (const [version, changed] of changes) {
    if (version === CURRENT) {
      await saveTranslation(app, pid, bookId, "replace");
      await updateJson(
        app.paths.phase3Edits(pid, bookId),
        ManualEdits,
        () => ({ schemaVersion: 1 as const, edits: {} }),
        (m) => {
          const edits = { ...m.edits };
          for (const [key, c] of Object.entries(changed))
            edits[key] = { text: c.text, at: nowIso(), previous: c.previous };
          return { ...m, edits };
        },
      );
    } else {
      await editSavedUnits(
        app,
        pid,
        bookId,
        version,
        Object.fromEntries(Object.entries(changed).map(([k, c]) => [k, c.text])),
      );
    }
  }
  return { passages, replaced, skipped };
}

export async function reviewUnits(
  app: AppContext,
  pid: string,
  bookId: string,
  chapterId: string,
  versions: string[],
) {
  const keys = await chapterKeys(app, pid, bookId, chapterId);
  const units = await loadAllUnits(app, pid, bookId);
  const cells = await Promise.all(versions.map((v) => versionCells(app, pid, bookId, v)));
  return {
    units: keys.flatMap((key) => {
      const u = units.get(key);
      if (!u) return [];
      return [
        {
          key,
          urlKey: encodeUnitKey(key),
          role: u.role,
          source: u.text,
          placeholders: u.placeholders.map((p) => ({
            n: p.n,
            kind: p.kind,
            label: p.label,
            required: p.required,
          })),
          versions: Object.fromEntries(versions.map((v, i) => [v, cells[i]!(key)])),
        },
      ];
    }),
  };
}

/** Your text for a passage of any version; the formatting tags must stay valid. */
export async function editVersionUnit(
  app: AppContext,
  pid: string,
  bookId: string,
  version: string,
  key: string,
  text: string,
): Promise<void> {
  if (version === CURRENT) return saveManualEdit(app, pid, bookId, key, text);
  await checkOwnText(app, pid, bookId, key, text);
  await editSavedUnit(app, pid, bookId, version, key, text);
}

export async function revertVersionUnit(
  app: AppContext,
  pid: string,
  bookId: string,
  version: string,
  key: string,
): Promise<void> {
  if (version === CURRENT) return removeManualEdit(app, pid, bookId, key);
  await revertSavedUnit(app, pid, bookId, version, key);
}

export interface RewriteRequest {
  /** The version whose passage is rewritten; its neighbours give the context. */
  version: string;
  /** The passage as it stands (possibly edited and not saved yet). */
  text: string;
  /** A part of `text` to rewrite; null rewrites the whole passage. */
  selection: { start: number; end: number } | null;
  modelId: string;
  /** Send the passages around it. */
  context: boolean;
  /** Send the reference and book knowledge bases. */
  knowledgeBases: boolean;
  instruction: string | null;
}

/** Passages sent around the one rewritten, with context on. */
const BEFORE = 3;
const AFTER = 2;

type Pair = { source: string; translation: string };

/**
 * A model's rewrite of a passage, or of a part of it, as a proposal: the
 * whole passage's new text. Nothing is saved.
 */
export async function rewritePassage(
  app: AppContext,
  pid: string,
  bookId: string,
  key: string,
  req: RewriteRequest,
): Promise<{ text: string; warnings: string[] }> {
  const units = await loadAllUnits(app, pid, bookId);
  const unit = units.get(key);
  if (!unit) throw new NotFoundError("Passage");
  const model = app.settings.model(req.modelId);
  const connection = model ? app.settings.connection(model.connectionId) : undefined;
  if (!model || !connection) throw new UserError("That model no longer exists.");
  const knowledge = await bookKnowledge(app, pid, bookId);
  const project = await app.projects.get(pid);
  const scripts = unicodeScriptsFor(project.targetScript);

  const text = req.text;
  const sel =
    req.selection &&
    req.selection.start >= 0 &&
    req.selection.end <= text.length &&
    req.selection.end > req.selection.start
      ? req.selection
      : null;
  const original = sel ? text.slice(sel.start, sel.end) : text;
  // A rewritten part keeps the spaces around it, so it fits back in.
  const splice = (out: string) =>
    sel
      ? `${text.slice(0, sel.start)}${/^\s*/.exec(original)![0]}${out.trim()}${/\s*$/.exec(original)![0]}${text.slice(sel.end)}`
      : out.trim();

  let around: { before: Pair[]; after: Pair[] } | null = null;
  if (req.context) {
    const plan = await loadPlan(app, pid, bookId);
    const chapter = plan?.chapters.find((c) =>
      c.chunks.some((i) => plan.chunks[i]?.unitKeys.includes(key)),
    );
    const keys = chapter ? chapter.chunks.flatMap((i) => plan!.chunks[i]?.unitKeys ?? []) : [];
    const at = keys.indexOf(key);
    const cells = await versionCells(app, pid, bookId, req.version);
    const pair = (k: string) => ({
      source: stripPlaceholders(units.get(k)?.text ?? ""),
      translation: stripPlaceholders(cells(k).text ?? ""),
    });
    around =
      at < 0
        ? null
        : {
            before: keys.slice(Math.max(0, at - BEFORE), at).map(pair),
            after: keys.slice(at + 1, at + 1 + AFTER).map(pair),
          };
  }

  const blocks = rewriteBlocks({
    sourceName: knowledge.languages.sourceName,
    targetName: knowledge.languages.targetName,
    targetTag: knowledge.languages.targetLang,
    languageNotes: knowledge.languageNotes,
    referenceKb: req.knowledgeBases ? knowledge.referenceKb : null,
    bookKb: req.knowledgeBases ? knowledge.bookKb : null,
    around,
    source: unit.text,
    translation: sel
      ? `${text.slice(0, sel.start)}${FRAGMENT_START}${original}${FRAGMENT_END}${text.slice(sel.end)}`
      : text,
    fragment: sel !== null,
    instruction: req.instruction?.trim() || null,
  });
  const ctx = {
    targetScripts: scripts,
    ratio: 1,
    languages: languageChecks(project.sourceLang, project.targetLang),
  };
  const result = await callStructured(
    app.rt,
    {
      connection,
      model,
      // The translation step's reasoning settings, with the chosen model; no advisor.
      step: {
        ...app.settings.get().steps["phase3.translate"],
        modelId: model.id,
        consultAdvisor: false,
      },
    },
    {
      projectId: pid,
      step: "phase3.translate",
      label: `Rewrite · ${stripPlaceholders(unit.text).slice(0, 60)}`,
      blocks,
      schema: RewriteOutput,
      schemaName: "rewrite",
      answerBudget: Math.ceil(estimateTokens(unit.text + text) * 1.5) + 300,
      validate: (out) => checkUnitTranslation(unit, splice(out.text), ctx).errors,
      useCache: false,
      lane: "interactive",
    },
  );
  const full = splice(result.value.text);
  return { text: full, warnings: checkUnitTranslation(unit, full, ctx).warnings };
}
