import { createHash } from "node:crypto";
import { z } from "zod";
import { renderRangesMarkdown } from "../epub/text.ts";
import type { JobContext } from "../jobs/runner.ts";
import { type ApplyContext, applyEdits, editProblems } from "../kb/edits.ts";
import { kindFamily } from "../kb/model.ts";
import { applyOverrides, deletedKeys } from "../kb/overrides.ts";
import { promptIds, renderKb } from "../kb/render.ts";
import { type CallTarget, callStructured, replyCandidates, withRoomToGrow } from "../llm/call.ts";
import { isLlmError } from "../llm/errors.ts";
import { estimateTokens } from "../llm/tokens.ts";
import {
  ChapterOutput,
  chapterBlocks,
  Edit,
  PHASE2_PROMPT_VERSION,
  ReviewOutput,
  reviewBlocks,
} from "../prompts/phase2.ts";
import type { AppContext } from "../server/context.ts";
import { loadBookStructure, loadSetup, referenceSelection } from "../services/books.ts";
import { segmentsAt } from "../services/pairs.ts";
import { UserError } from "../services/projects.ts";
import { nowIso, Usage } from "../shared/schemas/common.ts";
import {
  emptyKb,
  emptyOverrides,
  Kb,
  KbKind,
  KbOverrides,
  KbTreatment,
} from "../shared/schemas/kb.ts";
import { listDir, readJson, removePath, writeJson } from "../store/json.ts";
import { splitParts } from "./phase1.ts";

const Outcome = z.object({
  op: z.string(),
  id: z.string().nullable(),
  source: z.string().nullable(),
  result: z.enum(["applied", "rejected", "suggestion"]),
  message: z.string(),
  reason: z.string(),
  entryId: z.string().nullable(),
});

export const StepFile = z.object({
  schemaVersion: z.literal(1),
  step: z.number().int(),
  segmentId: z.string(),
  title: z.string(),
  part: z.object({ index: z.number(), count: z.number() }).nullable(),
  synopsis: z.string(),
  outcomes: z.array(Outcome),
  finishedAt: z.string(),
  usage: Usage,
});
export type StepFile = z.infer<typeof StepFile>;

const SynopsisFile = z.object({
  schemaVersion: z.literal(1),
  step: z.number(),
  segmentId: z.string(),
  title: z.string(),
  synopsis: z.string(),
});

export const ReviewFile = z.object({
  schemaVersion: z.literal(1),
  inputsHash: z.string(),
  outcomes: z.array(Outcome),
  finishedAt: z.string(),
});

interface StepPlan {
  segmentId: string;
  title: string;
  text: string;
  part: { index: number; count: number } | null;
}

/** promptIds() maps entry id → prompt id; edits need prompt id → entry id. */
function byPromptId(ids: Map<string, string>): Map<string, string> {
  return new Map([...ids].map(([entryId, promptId]) => [promptId, entryId]));
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

async function planSteps(
  app: AppContext,
  pid: string,
  bookId: string,
  target: CallTarget,
): Promise<StepPlan[]> {
  const structure = await loadBookStructure(app, pid, bookId);
  const setup = await loadSetup(app, pid, bookId);
  const epub = await app.books.open(app.paths.bookEpub(pid, bookId));
  const chosen = new Set(setup.phase2Segments);
  const maxChapter = Math.max(3000, Math.floor(target.model.contextWindow * 0.3));
  const steps: StepPlan[] = [];
  for (const seg of segmentsAt(structure, setup.tocDepth)) {
    if (!chosen.has(seg.id)) continue;
    const text = renderRangesMarkdown(epub, seg.ranges);
    if (!text.trim()) continue;
    const count = Math.max(1, Math.ceil(estimateTokens(text) / maxChapter));
    const parts = splitParts(text, count);
    for (const [i, p] of parts.entries()) {
      steps.push({
        segmentId: seg.id,
        title: seg.title,
        text: p,
        part: count > 1 ? { index: i, count } : null,
      });
    }
  }
  return steps;
}

/** Number of steps committed so far (consecutive step files from 0). */
async function committedSteps(app: AppContext, pid: string, bookId: string): Promise<number> {
  const names = new Set(await listDir(app.paths.phase2Dir(pid, bookId)));
  let n = 0;
  while (names.has(`step.${String(n).padStart(3, "0")}.json`)) n++;
  return n;
}

export async function loadSteps(app: AppContext, pid: string, bookId: string): Promise<StepFile[]> {
  const n = await committedSteps(app, pid, bookId);
  const out: StepFile[] = [];
  for (let i = 0; i < n; i++) {
    const s = await readJson(app.paths.phase2Step(pid, bookId, i), StepFile).catch(() => undefined);
    if (s) out.push(s);
  }
  return out;
}

/** Removes everything from step `from` on (for "re-run from chapter k"). */
async function dropFrom(app: AppContext, pid: string, bookId: string, from: number): Promise<void> {
  const total = await committedSteps(app, pid, bookId);
  for (let i = from; i < Math.max(total, from + 1); i++) {
    await removePath(app.paths.phase2Step(pid, bookId, i));
    await removePath(app.paths.phase2Snapshot(pid, bookId, i));
    await removePath(app.paths.phase2Synopsis(pid, bookId, i));
  }
  await removePath(app.paths.phase2Review(pid, bookId));
}

/** Unknown categories become "other" (models invent kinds like "note" or "title"). */
function coerceEdit(edit: unknown): unknown {
  if (typeof edit !== "object" || edit === null) return edit;
  const e = edit as { fields?: unknown };
  if (typeof e.fields !== "object" || e.fields === null) return edit;
  const f = { ...(e.fields as Record<string, unknown>) };
  const known = (values: readonly string[], v: unknown) =>
    typeof v === "string" && values.includes(v.toLowerCase());
  if (f.kind != null)
    f.kind = known(KbKind.options, f.kind) ? String(f.kind).toLowerCase() : "other";
  if (f.treatment != null)
    f.treatment = known(KbTreatment.options, f.treatment)
      ? String(f.treatment).toLowerCase()
      : "other";
  if (f.status != null && !known(["auto", "open"], f.status)) f.status = null;
  return { ...e, fields: f };
}

/** The synopsis and the well-formed edits of an answer that failed the checks. */
function salvageChapter(raw: string): (ChapterOutput & { dropped: number }) | null {
  for (const candidate of replyCandidates(raw, ChapterOutput)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const c = candidate as { synopsis?: unknown; edits?: unknown };
    const items = Array.isArray(c.edits) ? c.edits : [];
    const edits = items.flatMap((e) => {
      const parsed = Edit.safeParse(coerceEdit(e));
      return parsed.success ? [parsed.data] : [];
    });
    if (typeof c.synopsis !== "string" && edits.length === 0) continue;
    return {
      synopsis: typeof c.synopsis === "string" ? c.synopsis : "",
      edits,
      dropped: items.length - edits.length,
    };
  }
  return null;
}

function outcomeRows(outcomes: ReturnType<typeof applyEdits>["outcomes"]) {
  return outcomes.map((o) => ({
    op: o.edit.op,
    id: o.edit.id,
    source: o.edit.fields?.source ?? null,
    result: o.result,
    message: o.message,
    reason: o.edit.reason,
    entryId: o.entryId,
  }));
}

export async function phase2Job(app: AppContext, job: JobContext): Promise<void> {
  const pid = job.job.projectId;
  const bookId = job.job.targetId;
  const project = await app.projects.get(pid);
  let book = await app.projects.book(pid, bookId);
  const chapterTarget = app.settings.target("phase2.chapter");
  const reviewTarget = app.settings.target("phase2.review");
  const notes = await app.projects.languageNotes(pid);
  const selection = await referenceSelection(app, pid, book);
  const referenceKb = selection.text;

  const steps = await planSteps(app, pid, bookId, chapterTarget);
  if (steps.length === 0)
    throw new UserError("No chapters are selected for phase 2 (see the book's setup).");
  const fromStep = typeof job.job.params.fromStep === "number" ? job.job.params.fromStep : null;
  if (fromStep !== null) await dropFrom(app, pid, bookId, fromStep);
  const start = Math.min(await committedSteps(app, pid, bookId), steps.length);

  book = await app.projects.saveBook(pid, {
    ...book,
    phase2: { ...book.phase2, state: "running" },
  });
  app.events.changed(pid, "books", bookId);

  let working: Kb =
    start > 0
      ? ((await readJson(app.paths.phase2Snapshot(pid, bookId, start - 1), Kb)) ??
        emptyKb("book", book.title))
      : emptyKb("book", book.title);
  const synopses: { title: string; synopsis: string }[] = [];
  for (let i = 0; i < start; i++) {
    const s = await readJson(app.paths.phase2Synopsis(pid, bookId, i), SynopsisFile).catch(
      () => undefined,
    );
    if (s?.synopsis) synopses.push({ title: s.title, synopsis: s.synopsis });
  }
  const loadOverrides = async () =>
    (await readJson(app.paths.bookKbOverrides(pid, bookId), KbOverrides).catch(() => undefined)) ??
    emptyOverrides();
  const total = steps.length + 1;

  for (let s = start; s < steps.length; s++) {
    job.checkpoint();
    const step = steps[s]!;
    job.progress(
      s,
      total,
      `${step.title}${step.part ? ` (part ${step.part.index + 1}/${step.part.count})` : ""}`,
    );
    // Your answers and edits (made while the job runs) apply before every chapter.
    const overrides = await loadOverrides();
    working = applyOverrides(working, overrides);
    const ids = promptIds(working);
    const ctx: ApplyContext = {
      ids: byPromptId(ids),
      deleted: deletedKeys(overrides),
      refId: step.segmentId,
      refText: step.text,
    };
    const usageBefore = { ...job.job.usage };
    let output: ChapterOutput = { synopsis: "", edits: [] };
    try {
      const call = (answerBudget: number) =>
        callStructured(app.rt, chapterTarget, {
          projectId: pid,
          step: "phase2.chapter",
          label: `chapter ${s + 1}/${steps.length}: ${step.title}`.slice(0, 120),
          blocks: chapterBlocks({
            targetName: project.targetLangName,
            languageNotes: notes,
            referenceKb,
            synopses,
            bookKb: renderKb(working, { ids, markLocked: true }),
            chapterTitle: step.title,
            chapterText: step.text,
            part: step.part,
          }),
          schema: ChapterOutput,
          schemaName: "chapter_notes",
          answerBudget,
          // No repair turns over individual edits: rejected edits are recorded,
          // and the final review sees the result. Re-sending a long answer costs more.
          salvage: (raw) => {
            const rescued = salvageChapter(raw);
            if (rescued?.dropped)
              job.log(`Chapter "${step.title}": dropped ${rescued.dropped} malformed edits`);
            return rescued && { synopsis: rescued.synopsis, edits: rescued.edits };
          },
          promptCacheKey: `${pid}:phase2`,
          signal: job.signal,
          onUsage: job.addUsage,
        });
      // New chapters can bring many names; the budget grows with the text.
      const res = await withRoomToGrow(chapterTarget, 4000 + estimateTokens(step.text), call, () =>
        job.log(`Chapter "${step.title}": the answer was cut off; trying again with more room`),
      );
      output = res.value;
    } catch (error) {
      if (
        !isLlmError(error, "invalid_output") &&
        !isLlmError(error, "refusal") &&
        !isLlmError(error, "truncated")
      )
        throw error;
      // Keep the synopsis and every well-formed edit.
      const salvaged = salvageChapter(error.raw ?? "");
      if (salvaged) output = salvaged;
      if (!salvaged || salvaged.dropped > 0 || !isLlmError(error, "invalid_output"))
        job.itemError();
      job.log(
        `Chapter "${step.title}": ${error.message}${salvaged ? ` (kept ${salvaged.edits.length} edits${salvaged.dropped ? `, dropped ${salvaged.dropped} malformed` : ""})` : ""}`,
      );
    }
    const applied = applyEdits(working, output.edits, ctx);
    working = applied.kb;
    const usage = {
      ...job.job.usage,
      calls: job.job.usage.calls - usageBefore.calls,
      promptTokens: job.job.usage.promptTokens - usageBefore.promptTokens,
      cachedTokens: job.job.usage.cachedTokens - usageBefore.cachedTokens,
      cacheWriteTokens: job.job.usage.cacheWriteTokens - usageBefore.cacheWriteTokens,
      completionTokens: job.job.usage.completionTokens - usageBefore.completionTokens,
      reasoningTokens: job.job.usage.reasoningTokens - usageBefore.reasoningTokens,
      cost: job.job.usage.cost === null ? null : job.job.usage.cost - (usageBefore.cost ?? 0),
    };
    // Commit order: snapshot, synopsis, then the step file as the commit marker.
    await writeJson(app.paths.phase2Snapshot(pid, bookId, s), Kb, working);
    await writeJson(app.paths.phase2Synopsis(pid, bookId, s), SynopsisFile, {
      schemaVersion: 1,
      step: s,
      segmentId: step.segmentId,
      title: step.title,
      synopsis: output.synopsis.trim(),
    });
    await writeJson(app.paths.phase2Step(pid, bookId, s), StepFile, {
      schemaVersion: 1,
      step: s,
      segmentId: step.segmentId,
      title: step.title,
      part: step.part,
      synopsis: output.synopsis.trim(),
      outcomes: outcomeRows(applied.outcomes),
      finishedAt: nowIso(),
      usage,
    });
    if (output.synopsis.trim())
      synopses.push({ title: step.title, synopsis: output.synopsis.trim() });
    await writeJson(
      app.paths.bookKb(pid, bookId),
      Kb,
      applyOverrides(working, await loadOverrides()),
    );
    book = await app.projects.saveBook(pid, {
      ...book,
      phase2: { ...book.phase2, stepsDone: s + 1 },
    });
    app.events.changed(pid, "kb", bookId);
  }

  // Final review, in two batches (names, then terms and wordplay).
  job.checkpoint();
  job.progress(steps.length, total, "Final review");
  const overrides = await loadOverrides();
  working = applyOverrides(working, overrides);
  const reviewHash = sha([
    PHASE2_PROMPT_VERSION,
    working,
    synopses,
    reviewTarget.model.id,
    reviewTarget.step,
  ]);
  const existingReview = await readJson(app.paths.phase2Review(pid, bookId), ReviewFile).catch(
    () => undefined,
  );
  if (working.entries.length > 0 && existingReview?.inputsHash !== reviewHash) {
    const allOutcomes: ReturnType<typeof outcomeRows> = [];
    for (const family of ["names", "expressions"] as const) {
      const ids = promptIds(working);
      const members = working.entries.filter((e) => kindFamily(e.kind) === family);
      if (members.length === 0) continue;
      const ctx: ApplyContext = {
        ids: byPromptId(ids),
        deleted: deletedKeys(overrides),
        refId: null,
        refText: null,
      };
      const focus =
        family === "names"
          ? `Names: ${members.map((e) => ids.get(e.id)).join(", ")}`
          : `Terms, phrases and wordplay: ${members.map((e) => ids.get(e.id)).join(", ")}`;
      let edits: ReviewOutput["edits"] = [];
      try {
        const call = (answerBudget: number) =>
          callStructured(app.rt, reviewTarget, {
            projectId: pid,
            step: "phase2.review",
            label: `final review (${family})`,
            blocks: reviewBlocks({
              targetName: project.targetLangName,
              languageNotes: notes,
              referenceKb,
              synopses,
              bookKb: renderKb(working, { ids, markLocked: true }),
              focus,
            }),
            schema: ReviewOutput,
            schemaName: "review_edits",
            answerBudget,
            validate: (out) => editProblems(working, out.edits, ctx),
            signal: job.signal,
            onUsage: job.addUsage,
          });
        const res = await withRoomToGrow(reviewTarget, 1000 + members.length * 150, call);
        edits = res.value.edits;
      } catch (error) {
        if (!isLlmError(error, "invalid_output") && !isLlmError(error, "truncated")) throw error;
        job.itemError();
        const parsed = replyCandidates(error.raw ?? "", ReviewOutput)
          .map((c) => ReviewOutput.safeParse(c))
          .find((r) => r.success);
        if (parsed?.success) edits = parsed.data.edits;
      }
      const applied = applyEdits(working, edits, ctx);
      working = applied.kb;
      allOutcomes.push(...outcomeRows(applied.outcomes));
    }
    await writeJson(app.paths.phase2Review(pid, bookId), ReviewFile, {
      schemaVersion: 1,
      inputsHash: sha([
        PHASE2_PROMPT_VERSION,
        working,
        synopses,
        reviewTarget.model.id,
        reviewTarget.step,
      ]),
      outcomes: allOutcomes,
      finishedAt: nowIso(),
    });
  }
  const finalKb = applyOverrides(working, await loadOverrides());
  await writeJson(app.paths.bookKb(pid, bookId), Kb, finalKb);
  job.progress(
    total,
    total,
    `Knowledge base: ${finalKb.entries.length} entries, ${finalKb.entries.filter((e) => e.status === "open").length} open questions`,
  );
  book = await app.projects.saveBook(pid, {
    ...book,
    phase2: {
      state: job.job.itemErrors > 0 ? "done_with_errors" : "done",
      finishedAt: nowIso(),
      stepsDone: steps.length,
    },
  });
  app.events.changed(pid, "kb", bookId);
  app.events.changed(pid, "books", bookId);
}

export async function phase2Estimate(app: AppContext, pid: string, bookId: string) {
  const structure = await loadBookStructure(app, pid, bookId);
  const setup = await loadSetup(app, pid, bookId);
  const book = await app.projects.book(pid, bookId);
  const selection = await referenceSelection(app, pid, book);
  const chosen = new Set(setup.phase2Segments);
  const segs = segmentsAt(structure, setup.tocDepth).filter((s) => chosen.has(s.id));
  const words = segs.reduce((s, x) => s + x.words, 0);
  const steps = segs.length;
  return {
    steps,
    referenceTokens: selection.tokens,
    inputTokens: Math.round(words * 1.4 + steps * (selection.tokens + 4000)),
    cachedTokens: Math.round(steps * selection.tokens),
    outputTokens: Math.round(steps * 1500 + 3000),
  };
}
