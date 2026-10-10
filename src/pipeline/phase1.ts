import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { renderRangesMarkdown } from "../epub/text.ts";
import type { JobContext } from "../jobs/runner.ts";
import { assembleKb, resolveDecisions } from "../kb/assemble.ts";
import {
  type FindingGroup,
  groupDetail,
  groupFindings,
  groupIndexLine,
  groupStyleNotes,
  type UnitFindings,
} from "../kb/group.ts";
import { renderEntry } from "../kb/render.ts";
import { answerCap, callStructured, replyCandidates, withRoomToGrow } from "../llm/call.ts";
import { isLlmError } from "../llm/errors.ts";
import { estimateTokens } from "../llm/tokens.ts";
import {
  type Finding,
  type MergeDecision,
  MergeOutput,
  mergeSystem,
  PHASE1_PROMPT_VERSION,
  ReadOutput,
  readBlocks,
  type StyleNote,
  StyleOutput,
  styleBlocks,
} from "../prompts/phase1.ts";
import type { AppContext } from "../server/context.ts";
import { loadAlignment, loadStructure, segmentsAt } from "../services/pairs.ts";
import { UserError } from "../services/projects.ts";
import { nowIso } from "../shared/schemas/common.ts";
import { emptyOverrides, Kb, KbOverrides } from "../shared/schemas/kb.ts";
import { listDir, readJson, writeJson } from "../store/json.ts";

const FindingsFile = z.object({
  schemaVersion: z.literal(1),
  unitId: z.string(),
  part: z.object({ index: z.number(), count: z.number() }).nullable(),
  inputsHash: z.string(),
  output: ReadOutput,
});
const MergeFile = z.object({
  schemaVersion: z.literal(1),
  batch: z.array(z.string()),
  inputsHash: z.string(),
  output: MergeOutput,
});
const StyleFile = z.object({
  schemaVersion: z.literal(1),
  inputsHash: z.string(),
  output: StyleOutput,
});

/**
 * Runs tasks in parallel and throws the first error once all have ended.
 * A wrong key or address would fail every request the same way, so it
 * cancels the requests still waiting or running instead: it fails once, not
 * once per chapter. Other errors let the rest finish, so their work is saved.
 */
async function allUntilFatal<T>(
  items: T[],
  parent: AbortSignal,
  run: (item: T, index: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const stop = new AbortController();
  const signal = AbortSignal.any([parent, stop.signal]);
  let failure: { error: unknown } | null = null;
  await Promise.all(
    items.map((item, i) =>
      run(item, i, signal).catch((error: unknown) => {
        failure ??= { error };
        if (isLlmError(error) && (error.kind === "config" || error.kind === "auth")) stop.abort();
      }),
    ),
  );
  if (failure) throw (failure as { error: unknown }).error;
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** Splits text into `count` parts at paragraph boundaries; `overlap` widens each part (fraction). */
export function splitParts(text: string, count: number, overlap = 0): string[] {
  if (count <= 1) return [text];
  const paras = text.split(/\n{2,}/);
  const total = paras.reduce((s, p) => s + p.length + 2, 0);
  const mids: number[] = [];
  let pos = 0;
  for (const p of paras) {
    mids.push((pos + p.length / 2) / total);
    pos += p.length + 2;
  }
  return Array.from({ length: count }, (_, i) => {
    const from = i / count - overlap;
    const to = (i + 1) / count + overlap;
    return paras.filter((_, k) => mids[k]! >= from && mids[k]! < to).join("\n\n");
  });
}

interface ReadTask {
  unitId: string;
  part: { index: number; count: number } | null;
  sourceText: string;
  targetText: string;
  file: string;
  hash: string;
}

export async function phase1Job(app: AppContext, job: JobContext): Promise<void> {
  const pid = job.job.projectId;
  const pairId = job.job.targetId;
  const project = await app.projects.get(pid);
  let pair = await app.projects.pair(pid, pairId);
  const alignment = await loadAlignment(app, pid, pairId);
  if (alignment.status !== "confirmed") throw new UserError("Confirm the chapter alignment first.");
  const readTarget = app.settings.target("phase1.read");
  const mergeTarget = app.settings.target("phase1.merge");
  const notes = await app.projects.languageNotes(pid);
  const sourceStructure = await loadStructure(app, pid, pairId, "source");
  const targetStructure = await loadStructure(app, pid, pairId, "target");
  const sourceBook = await app.books.open(app.paths.pairEpub(pid, pairId, "source"));
  const targetBook = await app.books.open(app.paths.pairEpub(pid, pairId, "target"));
  const srcSegs = new Map(
    segmentsAt(sourceStructure, alignment.tocDepthSource).map((s) => [s.id, s]),
  );
  const tgtSegs = new Map(
    segmentsAt(targetStructure, alignment.tocDepthTarget).map((s) => [s.id, s]),
  );

  pair = await app.projects.savePair(pid, {
    ...pair,
    phase1: { ...pair.phase1, state: "running" },
  });
  app.events.changed(pid, "pairs", pairId);

  // 1. Chapter texts, split when a pair wouldn't fit the read model comfortably.
  const system = readBlocks({
    targetName: project.targetLangName,
    languageNotes: notes,
    sourceText: "",
    targetText: "",
    part: null,
  })[0]!.text;
  const budget = Math.floor(readTarget.model.contextWindow * 0.5) - estimateTokens(system);
  // Findings grow with the chapter; parts are kept small enough that they fit the output limit.
  const sourcePerPart = Math.max(2000, answerCap(readTarget) - 2000);
  const tasks: ReadTask[] = [];
  const unitIds: string[] = [];
  for (const [position, unit] of alignment.units.entries()) {
    if (!unit.include || unit.source.length === 0 || unit.target.length === 0) continue;
    unitIds.push(unit.id);
    const sourceText = renderRangesMarkdown(
      sourceBook,
      unit.source.flatMap((id) => srcSegs.get(id)?.ranges ?? []),
    );
    const targetText = renderRangesMarkdown(
      targetBook,
      unit.target.flatMap((id) => tgtSegs.get(id)?.ranges ?? []),
    );
    const tokens = estimateTokens(sourceText) + estimateTokens(targetText);
    const count = Math.max(
      1,
      Math.ceil(tokens / Math.max(budget, 2000)),
      Math.ceil(estimateTokens(sourceText) / sourcePerPart),
    );
    const sourceParts = splitParts(sourceText, count);
    const targetParts = splitParts(targetText, count, count > 1 ? 0.08 : 0);
    for (let i = 0; i < count; i++) {
      const part = count > 1 ? { index: i, count } : null;
      const hash = sha([
        PHASE1_PROMPT_VERSION,
        system,
        sourceParts[i],
        targetParts[i],
        readTarget.model.id,
        readTarget.model.modelName,
        readTarget.step,
      ]);
      tasks.push({
        unitId: unit.id,
        part,
        sourceText: sourceParts[i]!,
        targetText: targetParts[i]!,
        file: app.paths.phase1Findings(pid, pairId, position, count > 1 ? i : null),
        hash,
      });
    }
  }
  if (tasks.length === 0) throw new UserError("No rows of the alignment are included.");

  // 2. Read every chapter pair (in parallel; the model's limit caps requests).
  const total = tasks.length + 2;
  let done = 0;
  job.stages([
    { key: "read", label: "Reading chapter pairs", total: tasks.length },
    { key: "merge", label: "Merging findings" },
    { key: "style", label: "Style rules", total: 1 },
    { key: "save", label: "Building the knowledge base", total: 1 },
  ]);
  const results = new Map<ReadTask, UnitFindings | null>();
  const pending: ReadTask[] = [];
  for (const t of tasks) {
    const existing = await readJson(t.file, FindingsFile).catch(() => undefined);
    if (existing && existing.inputsHash === t.hash) {
      results.set(t, {
        unitId: t.unitId,
        findings: existing.output.findings,
        styleNotes: existing.output.styleNotes,
      });
      done++;
    } else {
      pending.push(t);
    }
  }
  job.progress(done, total, "Reading chapter pairs");
  let readDone = done;
  job.stage("read", { done: readDone, state: pending.length > 0 ? "running" : "done" });
  const read = async (t: ReadTask, _i: number, signal: AbortSignal) => {
    job.checkpoint();
    try {
      const label = `read ${t.unitId}${t.part ? ` part ${t.part.index + 1}/${t.part.count}` : ""}`;
      const call = (answerBudget: number) =>
        callStructured(app.rt, readTarget, {
          projectId: pid,
          step: "phase1.read",
          label,
          blocks: readBlocks({
            targetName: project.targetLangName,
            languageNotes: notes,
            sourceText: t.sourceText,
            targetText: t.targetText,
            part: t.part,
          }),
          schema: ReadOutput,
          schemaName: "chapter_findings",
          answerBudget,
          signal,
          onUsage: job.addUsage,
        });
      // A chapter with many names can need more room than expected.
      const res = await withRoomToGrow(readTarget, 2000 + estimateTokens(t.sourceText), call, () =>
        job.log(`${label}: the answer was cut off; trying again with more room`),
      );
      await writeJson(t.file, FindingsFile, {
        schemaVersion: 1,
        unitId: t.unitId,
        part: t.part,
        inputsHash: t.hash,
        output: res.value,
      });
      results.set(t, {
        unitId: t.unitId,
        findings: res.value.findings,
        styleNotes: res.value.styleNotes,
      });
    } catch (error) {
      if (
        isLlmError(error) &&
        (error.kind === "aborted" || error.kind === "auth" || error.kind === "config")
      )
        throw error;
      if (error instanceof Error && error.name === "PauseSignal") throw error;
      job.itemError();
      job.log(`Couldn't read ${t.unitId}: ${(error as Error).message}`);
      results.set(t, null);
    } finally {
      done++;
      readDone++;
      job.progress(done, total, "Reading chapter pairs");
      job.stage("read", { done: readDone });
    }
  };
  // All at once: each chapter is a different prompt, so there is no shared
  // prefix worth warming a cache with first.
  await allUntilFatal(pending, job.signal, read);
  job.stage("read", { state: "done" });
  job.checkpoint();

  // 3. Group findings by code.
  const unitFindings = [...results.values()].filter((r): r is UnitFindings => r !== null);
  const groups = groupFindings(unitFindings);
  const styleGroups = groupStyleNotes(unitFindings);

  // 4. Merge in batches; the index of all groups (and locked entries) is the cached prefix.
  const existing =
    (await readJson(app.paths.pairKb(pid, pairId), Kb).catch(() => undefined)) ?? null;
  const overrides =
    (await readJson(app.paths.pairKbOverrides(pid, pairId), KbOverrides).catch(() => undefined)) ??
    emptyOverrides();
  const locked = Object.values(overrides.entries)
    .map((o) => o.entry)
    .filter((e): e is NonNullable<typeof e> => e !== null);
  const lockedIds = new Map(locked.map((e, i) => [`p${i + 1}`, e.id]));
  const index = [
    ...groups.map(groupIndexLine),
    ...locked.map((e, i) =>
      renderEntry(e, { ids: new Map([[e.id, `p${i + 1}`]]) }).replace(/^- /, ""),
    ),
  ].join("\n");
  const mergeSys = mergeSystem(project.targetLangName, notes);
  // A decision with a full entry runs to about 200 tokens. Batches aim at
  // answers of about 7000 tokens, and each call gets twice that much room.
  const perDecision = 200;
  const cap = answerCap(mergeTarget);
  const batchSize = Math.max(
    10,
    Math.min(120, Math.floor(Math.min(cap * 0.5, 7000) / perDecision)),
  );
  const batches: FindingGroup[][] = [];
  for (let i = 0; i < groups.length; i += batchSize) batches.push(groups.slice(i, i + batchSize));
  const decisions = new Map<string, MergeDecision>();
  job.progress(done, total, `Merging ${groups.length} findings`);
  let mergeDone = 0;
  job.stage("merge", {
    label: `Merging ${groups.length} findings`,
    total: batches.length,
    done: 0,
    state: batches.length > 0 ? "running" : "done",
  });

  const validIds = new Set([...groups.map((g) => g.id), ...lockedIds.keys()]);
  const validateFor = (ids: string[]) => (out: MergeOutput) => {
    const problems: string[] = [];
    const seen = new Map<string, number>();
    for (const d of out.decisions) seen.set(d.group, (seen.get(d.group) ?? 0) + 1);
    for (const id of ids) if (!seen.has(id)) problems.push(`group ${id} has no decision`);
    for (const [id, count] of seen) {
      if (!ids.includes(id)) problems.push(`${id} isn't in this batch`);
      else if (count > 1) problems.push(`${id} has ${count} decisions; give one`);
    }
    for (const d of out.decisions) {
      if (d.action === "merge_into" && (!d.into || !validIds.has(d.into) || d.into === d.group)) {
        problems.push(`${d.group}: "into" must be another gN or pN id from the index`);
      }
    }
    return problems;
  };
  /** Decisions for some groups; a batch whose answer gets cut off is split in two. */
  const decide = async (
    part: FindingGroup[],
    label: string,
    signal: AbortSignal,
  ): Promise<MergeDecision[]> => {
    job.checkpoint();
    const ids = part.map((g) => g.id);
    try {
      const res = await callStructured(app.rt, mergeTarget, {
        projectId: pid,
        step: "phase1.merge",
        label,
        blocks: [
          { role: "system", label: "instructions", text: mergeSys },
          {
            role: "user",
            label: "index",
            text: `# Index of all groups and existing entries\n${index}`,
            cacheBreakpoint: true,
          },
          {
            role: "user",
            label: "batch",
            text: `# Decide these groups\n${part.map(groupDetail).join("\n\n")}`,
          },
        ],
        schema: MergeOutput,
        schemaName: "merge_decisions",
        answerBudget: Math.min(cap, 2 * perDecision * part.length + 300),
        validate: validateFor(ids),
        signal,
        onUsage: job.addUsage,
      });
      return res.value.decisions;
    } catch (error) {
      if (isLlmError(error, "truncated") && part.length >= 4) {
        job.log(`${label}: the answer was cut off; splitting the batch`);
        const mid = Math.ceil(part.length / 2);
        return [
          ...(await decide(part.slice(0, mid), `${label} (first half)`, signal)),
          ...(await decide(part.slice(mid), `${label} (second half)`, signal)),
        ];
      }
      if (
        !isLlmError(error, "invalid_output") &&
        !isLlmError(error, "truncated") &&
        !isLlmError(error, "refusal")
      )
        throw error;
      // Keep whatever decisions were valid; the rest are built from the group data.
      job.itemError();
      job.log(`${label}: ${(error as Error).message}`);
      const parsed = replyCandidates(error.raw ?? "", MergeOutput)
        .map((c) => MergeOutput.safeParse(c))
        .find((r) => r.success);
      return parsed?.success ? parsed.data.decisions.filter((d) => ids.includes(d.group)) : [];
    }
  };
  const runBatch = async (batch: FindingGroup[], n: number, signal: AbortSignal) => {
    job.checkpoint();
    const ids = batch.map((g) => g.id);
    const hash = sha([
      PHASE1_PROMPT_VERSION,
      mergeSys,
      index,
      batch.map(groupDetail),
      mergeTarget.model.id,
      mergeTarget.step,
    ]);
    const file = app.paths.phase1Merge(pid, pairId, n);
    const cached = await readJson(file, MergeFile).catch(() => undefined);
    let output: MergeOutput | null = cached && cached.inputsHash === hash ? cached.output : null;
    if (!output) {
      output = {
        decisions: await decide(batch, `merge batch ${n + 1}/${batches.length}`, signal),
      };
      await writeJson(file, MergeFile, { schemaVersion: 1, batch: ids, inputsHash: hash, output });
    }
    for (const d of output.decisions)
      if (ids.includes(d.group) && !decisions.has(d.group)) decisions.set(d.group, d);
    mergeDone++;
    job.stage("merge", { done: mergeDone });
  };
  // The first batch runs alone, so the rest find the shared index already cached.
  if (batches.length > 0) {
    await runBatch(batches[0]!, 0, job.signal);
    await allUntilFatal(batches.slice(1), job.signal, (b, i, signal) => runBatch(b, i + 1, signal));
  }
  done++;
  job.stage("merge", { state: "done" });
  job.progress(done, total, "Summarizing style");
  job.stage("style", { state: styleGroups.length > 0 ? "running" : "skipped" });
  job.checkpoint();

  // 5. Style rules.
  let style: StyleOutput | null = null;
  if (styleGroups.length > 0) {
    const notesText = styleGroups
      .slice(0, 300)
      .map(
        (g) =>
          `- (${g.count}×) ${g.rule}${g.example ? ` e.g. "${g.example.source}" → "${g.example.target}"` : ""}`,
      )
      .join("\n");
    const hash = sha([PHASE1_PROMPT_VERSION, notesText, mergeTarget.model.id, mergeTarget.step]);
    const file = app.paths.phase1Merge(pid, pairId, "style");
    const cached = await readJson(file, StyleFile).catch(() => undefined);
    if (cached && cached.inputsHash === hash) style = cached.output;
    else {
      try {
        const call = (answerBudget: number) =>
          callStructured(app.rt, mergeTarget, {
            projectId: pid,
            step: "phase1.merge",
            label: "style rules",
            blocks: styleBlocks(project.targetLangName, notes, notesText),
            schema: StyleOutput,
            schemaName: "style_rules",
            answerBudget,
            signal: job.signal,
            onUsage: job.addUsage,
          });
        style = (await withRoomToGrow(mergeTarget, 3000, call)).value;
        await writeJson(file, StyleFile, { schemaVersion: 1, inputsHash: hash, output: style });
      } catch (error) {
        if (
          !isLlmError(error, "invalid_output") &&
          !isLlmError(error, "truncated") &&
          !isLlmError(error, "refusal")
        )
          throw error;
        // The entries are still worth keeping; style rules can come from a later run.
        job.itemError();
        job.log(`Style rules: ${error.message}`);
      }
    }
  }

  if (styleGroups.length > 0) job.stage("style", { state: "done", done: 1 });
  job.stage("save", { state: "running" });

  // 6. Assemble the knowledge base and re-apply your edits.
  const resolution = resolveDecisions(groups, decisions, lockedIds);
  const kb = assembleKb({
    scope: "pair",
    title: pair.title,
    resolution,
    style,
    existing,
    overrides,
  });
  await writeJson(app.paths.pairKb(pid, pairId), Kb, kb);
  done++;
  job.stage("save", { state: "done", done: 1 });
  job.progress(
    done,
    total,
    `Knowledge base: ${kb.entries.length} entries, ${kb.styleRules.length} style rules`,
  );
  pair = await app.projects.savePair(pid, {
    ...pair,
    phase1: {
      state: job.job.itemErrors > 0 ? "done_with_errors" : "done",
      finishedAt: nowIso(),
      entries: kb.entries.length,
    },
  });
  app.events.changed(pid, "kb", pairId);
  app.events.changed(pid, "pairs", pairId);
}

/** Rough size of phase 1 for a pair, before running it. */
export async function phase1Estimate(app: AppContext, pid: string, pairId: string) {
  const alignment = await loadAlignment(app, pid, pairId);
  const source = await loadStructure(app, pid, pairId, "source");
  const target = await loadStructure(app, pid, pairId, "target");
  const sw = new Map(segmentsAt(source, alignment.tocDepthSource).map((s) => [s.id, s.words]));
  const tw = new Map(segmentsAt(target, alignment.tocDepthTarget).map((s) => [s.id, s.words]));
  let words = 0;
  let units = 0;
  for (const u of alignment.units) {
    if (!u.include || u.source.length === 0 || u.target.length === 0) continue;
    units++;
    words +=
      u.source.reduce((s, id) => s + (sw.get(id) ?? 0), 0) +
      u.target.reduce((s, id) => s + (tw.get(id) ?? 0), 0);
  }
  const inputTokens = Math.round(words * 1.4 + units * 1500);
  return { units, inputTokens, outputTokens: Math.round(units * 1500 + 3000) };
}

// ---------------------------------------------------------------------------
// What each chapter pair produced, for watching phase 1 while it runs
// ---------------------------------------------------------------------------

function findingsFilesFor(names: string[], position: number): string[] {
  return names.filter((n) => n === `u${position}.json` || n.startsWith(`u${position}.p`)).sort();
}

/** Every included chapter pair with whether it has been read and what it found. */
export async function phase1Chapters(app: AppContext, pid: string, pairId: string) {
  const alignment = await loadAlignment(app, pid, pairId);
  const titles = async (side: "source" | "target", depth: number) =>
    new Map(
      segmentsAt(await loadStructure(app, pid, pairId, side), depth).map((s) => [s.id, s.title]),
    );
  const source = await titles("source", alignment.tocDepthSource);
  const target = await titles("target", alignment.tocDepthTarget);
  const dir = app.paths.phase1FindingsDir(pid, pairId);
  const names = await listDir(dir);
  const chapters = [];
  for (const [position, unit] of alignment.units.entries()) {
    if (!unit.include || unit.source.length === 0 || unit.target.length === 0) continue;
    let findings = 0;
    let styleNotes = 0;
    let parts = 0;
    for (const name of findingsFilesFor(names, position)) {
      const file = await readJson(path.join(dir, name), FindingsFile).catch(() => undefined);
      if (!file) continue;
      parts++;
      findings += file.output.findings.length;
      styleNotes += file.output.styleNotes.length;
    }
    chapters.push({
      position,
      unitId: unit.id,
      source: unit.source.map((id) => source.get(id) ?? id),
      target: unit.target.map((id) => target.get(id) ?? id),
      read: parts > 0,
      findings,
      styleNotes,
    });
  }
  return { chapters };
}

/** What the AI noted in one chapter pair (all parts of a long chapter together). */
export async function phase1ChapterFindings(
  app: AppContext,
  pid: string,
  pairId: string,
  position: number,
) {
  const dir = app.paths.phase1FindingsDir(pid, pairId);
  const findings: Finding[] = [];
  const styleNotes: StyleNote[] = [];
  for (const name of findingsFilesFor(await listDir(dir), position)) {
    const file = await readJson(path.join(dir, name), FindingsFile).catch(() => undefined);
    if (!file) continue;
    findings.push(...file.output.findings);
    styleNotes.push(...file.output.styleNotes);
  }
  return { findings, styleNotes };
}
