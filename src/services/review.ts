import { stripPlaceholders } from "../epub/blocks.ts";
import { callStructured } from "../llm/call.ts";
import { estimateTokens } from "../llm/tokens.ts";
import { loadResults } from "../pipeline/phase3.ts";
import { bookKnowledge } from "../pipeline/phase3-job.ts";
import { checkUnitTranslation } from "../pipeline/validate.ts";
import { FRAGMENT_END, FRAGMENT_START, RewriteOutput, rewriteBlocks } from "../prompts/rewrite.ts";
import type { AppContext } from "../server/context.ts";
import { unicodeScriptsFor } from "../shared/languages.ts";
import type { UnitStatus } from "../shared/schemas/translation.ts";
import { editSavedUnit, loadSavedTranslation, revertSavedUnit } from "./history.ts";
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
  const ctx = { targetScripts: scripts, ratio: 1 };
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
