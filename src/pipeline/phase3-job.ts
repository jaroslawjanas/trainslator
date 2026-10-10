import { createHash } from "node:crypto";
import { EXTRACTOR_VERSION } from "../epub/blocks.ts";
import type { JobContext } from "../jobs/runner.ts";
import { renderKb } from "../kb/render.ts";
import type { AppContext } from "../server/context.ts";
import { loadBookStructure, loadSetup, referenceSelection } from "../services/books.ts";
import { recordBuild, saveTranslation, startOver } from "../services/history.ts";
import { segmentsAt } from "../services/pairs.ts";
import { languageDisplayName } from "../shared/languages.ts";
import { nowIso } from "../shared/schemas/common.ts";
import { Kb } from "../shared/schemas/kb.ts";
import { ChunkResult, Phase3Plan } from "../shared/schemas/translation.ts";
import {
  listDir,
  readJson,
  readText,
  removePath,
  writeFileAtomic,
  writeJson,
} from "../store/json.ts";
import { buildBook } from "./build.ts";
import { loadSteps } from "./phase2.ts";
import {
  chapterWindow,
  defaultChunkTokens,
  loadResults,
  type Phase3Env,
  preparePhase3,
  retranslateChunk,
  retranslateUnit,
  runPhase3,
  storySoFar,
  translateToc,
} from "./phase3.ts";

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** What a translation request knows about the book: languages, notes and both knowledge bases. */
export async function bookKnowledge(app: AppContext, pid: string, bookId: string) {
  const project = await app.projects.get(pid);
  const book = await app.projects.book(pid, bookId);
  const selection = await referenceSelection(app, pid, book);
  const bookKb = await readJson(app.paths.bookKb(pid, bookId), Kb).catch(() => undefined);
  return {
    book,
    languages: {
      sourceLang: project.sourceLang,
      sourceName: languageDisplayName(project.sourceLang),
      targetLang: project.targetLang,
      targetName: project.targetLangName,
      targetScript: project.targetScript,
    },
    languageNotes: await app.projects.languageNotes(pid),
    referenceKb: selection.text,
    bookKb:
      bookKb && (bookKb.entries.length > 0 || bookKb.styleRules.length > 0)
        ? renderKb(bookKb, { markLocked: true })
        : null,
  };
}

/** Everything phase 3 needs for a book, built from the project's files and settings. */
export async function phase3Env(
  app: AppContext,
  pid: string,
  bookId: string,
  job: JobContext | null,
): Promise<Phase3Env> {
  const { book, languages, languageNotes, referenceKb, bookKb } = await bookKnowledge(
    app,
    pid,
    bookId,
  );
  const setup = await loadSetup(app, pid, bookId);
  const structure = await loadBookStructure(app, pid, bookId);
  const synopses = new Map<string, string>();
  for (const step of await loadSteps(app, pid, bookId)) {
    if (!step.synopsis) continue;
    synopses.set(
      step.segmentId,
      synopses.has(step.segmentId)
        ? `${synopses.get(step.segmentId)} ${step.synopsis}`
        : step.synopsis,
    );
  }
  const target = app.settings.target("phase3.translate");
  let tocTarget = target;
  try {
    tocTarget = app.settings.target("utility");
  } catch {
    // fall back to the translation model
  }
  return {
    rt: app.rt,
    paths: app.paths,
    projectId: pid,
    bookId,
    target,
    tocTarget,
    book: await app.books.open(app.paths.bookEpub(pid, bookId)),
    languages,
    languageNotes,
    referenceKb,
    bookKb,
    synopses,
    segments: segmentsAt(structure, setup.tocDepth),
    keepDocs: new Set(setup.keepDocs),
    mode: book.translationMode,
    signal: job?.signal,
    onProgress: job
      ? (done, total, label) => {
          job.progress(done, total, label);
          job.stage("chunks", { done, total });
        }
      : undefined,
    onUsage: job ? (u) => job.addUsage(u) : undefined,
    log: job ? (m) => job.log(m) : undefined,
  };
}

/** The plan only changes when the setup or extractor changes; translations carry over by unit. */
async function ensurePlan(app: AppContext, env: Phase3Env) {
  const setup = await loadSetup(app, env.projectId, env.bookId);
  const setupHash = sha([
    setup.tocDepth,
    setup.keepDocs,
    EXTRACTOR_VERSION,
    defaultChunkTokens(env),
    // Only in chapters mode, so plans made before the choice existed stay valid.
    ...(env.mode === "chapters" ? ["chapters"] : []),
  ]);
  const existing = await readJson(
    app.paths.phase3Plan(env.projectId, env.bookId),
    Phase3Plan,
  ).catch(() => undefined);
  const hashFile = `${app.paths.phase3Plan(env.projectId, env.bookId)}.hash`;
  const oldHash = (await readText(hashFile))?.trim();
  if (existing && oldHash === setupHash) {
    return preparePhase3WithPlan(env, existing);
  }
  const oldResults = existing
    ? await loadResults(app.paths, env.projectId, env.bookId)
    : new Map<number, ChunkResult>();
  const prepared = await preparePhase3(env);
  await writeFileAtomic(hashFile, setupHash);
  if (oldResults.size > 0) {
    // Carry finished translations over to the new chunks, unit by unit.
    const byKey = new Map<
      string,
      { text: string; status: string; warnings: string[]; from: ChunkResult }
    >();
    for (const r of oldResults.values())
      for (const u of r.units)
        if (u.text !== null)
          byKey.set(u.key, { text: u.text, status: u.status, warnings: u.warnings, from: r });
    for (const name of await listDir(app.paths.phase3ResultsDir(env.projectId, env.bookId))) {
      await removePath(`${app.paths.phase3ResultsDir(env.projectId, env.bookId)}/${name}`);
    }
    for (const chunk of prepared.plan.chunks) {
      const units = chunk.unitKeys.map((k) => byKey.get(k));
      if (units.some((u) => u?.status !== "ok")) continue;
      // Model and settings, when every unit came from chunks that agree on them.
      const same = <T>(pick: (r: ChunkResult) => T, none: T): T => {
        const values = new Set(units.map((u) => pick(u!.from)));
        return values.size === 1 ? [...values][0]! : none;
      };
      await writeJson(app.paths.phase3Result(env.projectId, env.bookId, chunk.index), ChunkResult, {
        schemaVersion: 1,
        chunkIndex: chunk.index,
        chapterId: chunk.chapterId,
        inputsHash: "carried-over",
        promptVersion: 0,
        modelId: same((r) => r.modelId, ""),
        mode: same((r) => r.mode, null),
        reasoning: same((r) => r.reasoning, null),
        instruction: null,
        finishedAt: nowIso(),
        usage: {
          calls: 0,
          promptTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          cost: null,
          estimated: false,
        },
        units: chunk.unitKeys.map((k, i) => ({
          key: k,
          text: units[i]!.text,
          status: "ok" as const,
          warnings: units[i]!.warnings,
          errors: [],
        })),
        history: [],
      });
    }
  }
  return prepared;
}

async function preparePhase3WithPlan(env: Phase3Env, plan: Phase3Plan) {
  // Units are re-extracted (cheap and deterministic); the saved plan keeps chunk numbers stable.
  const prepared = await preparePhase3({ ...env, chunkTokens: plan.chunkTokens });
  const samePlan = JSON.stringify(prepared.plan.chunks) === JSON.stringify(plan.chunks);
  if (!samePlan) {
    await writeJson(env.paths.phase3Plan(env.projectId, env.bookId), Phase3Plan, plan);
    return { ...prepared, plan };
  }
  return prepared;
}

export async function preparedFor(
  app: AppContext,
  pid: string,
  bookId: string,
  job: JobContext | null,
) {
  const env = await phase3Env(app, pid, bookId, job);
  return { env, prepared: await ensurePlan(app, env) };
}

export async function phase3Job(app: AppContext, job: JobContext): Promise<void> {
  const pid = job.job.projectId;
  const bookId = job.job.targetId;
  let book = await app.projects.book(pid, bookId);
  book = await app.projects.saveBook(pid, {
    ...book,
    phase3: { ...book.phase3, state: "running" },
  });
  app.events.changed(pid, "books", bookId);
  if (job.job.params.fresh === true) {
    await startOver(app, pid, bookId, job.job.id);
    app.events.changed(pid, "phase3", bookId);
  }
  const { env, prepared } = await preparedFor(app, pid, bookId, job);
  env.checkpoint = () => job.checkpoint();
  // Translating the whole book again means new answers, even to the same requests.
  if (job.job.params.fresh === true) env.useCache = false;
  const inParts = prepared.plan.chapters.some((c) => c.chunks.length > 1);
  job.stages([
    {
      key: "chunks",
      label:
        env.mode === "chapters"
          ? `Translating chapters${inParts ? " (long ones in parts)" : ""}`
          : "Translating chunks",
      total: prepared.plan.chunks.length,
    },
    { key: "toc", label: "Title and table of contents", total: 1 },
  ]);
  job.stage("chunks", { state: "running" });
  const summary = await runPhase3(env, prepared);
  job.stage("chunks", { state: "done", done: summary.chunks, total: summary.chunks });
  job.checkpoint();
  job.progress(summary.chunks, summary.chunks, "Translating the title and table of contents");
  job.stage("toc", { state: "running" });
  await translateToc(env, prepared);
  job.stage("toc", { state: "done", done: 1 });
  for (let i = 0; i < summary.flagged + summary.refused; i++) job.itemError();
  book = await app.projects.saveBook(pid, {
    ...book,
    phase3: {
      state: summary.flagged + summary.refused > 0 ? "done_with_errors" : "done",
      finishedAt: nowIso(),
    },
  });
  job.progress(
    summary.chunks,
    summary.chunks,
    `${summary.ok} units translated, ${summary.flagged} flagged, ${summary.refused} refused`,
  );
  await saveTranslation(app, pid, bookId, "run");
  app.events.changed(pid, "phase3", bookId);
  app.events.changed(pid, "books", bookId);
}

export async function retranslateJob(app: AppContext, job: JobContext): Promise<void> {
  const pid = job.job.projectId;
  const bookId = job.job.targetId;
  const { env, prepared } = await preparedFor(app, pid, bookId, job);
  const instruction =
    typeof job.job.params.instruction === "string" && job.job.params.instruction.trim()
      ? job.job.params.instruction.trim()
      : null;
  if (typeof job.job.params.unitKey === "string") {
    job.progress(0, 1, "Re-translating one unit");
    await retranslateUnit(env, prepared, job.job.params.unitKey, instruction);
  } else if (typeof job.job.params.chunkIndex === "number") {
    job.progress(0, 1, `Re-translating chunk ${job.job.params.chunkIndex + 1}`);
    await retranslateChunk(env, prepared, job.job.params.chunkIndex, instruction);
  }
  job.progress(1, 1, "Done");
  app.events.changed(pid, "phase3", bookId);
}

export async function buildJob(app: AppContext, job: JobContext): Promise<void> {
  const pid = job.job.projectId;
  const bookId = job.job.targetId;
  const project = await app.projects.get(pid);
  let book = await app.projects.book(pid, bookId);
  const setup = await loadSetup(app, pid, bookId);
  job.progress(0, 1, "Building the EPUB");
  const epub = await app.books.open(app.paths.bookEpub(pid, bookId));
  const useBestAttempts = job.job.params.useBestAttempts === true;
  const { file, report } = await buildBook({
    paths: app.paths,
    projectId: pid,
    bookId,
    book: epub,
    sourceLang: project.sourceLang,
    targetLang: project.targetLang,
    direction: project.direction,
    keepDocs: new Set(setup.keepDocs),
    baseName: book.sourceFileName.replace(/\.epub$/i, ""),
    options: {
      useBestAttempts,
      newIdentifier: book.options.newIdentifier,
      removeEmbeddedFonts: book.options.removeEmbeddedFonts,
    },
  });
  await recordBuild(app, pid, bookId, file, {
    builtAt: report.builtAt,
    fileName: report.fileName,
    useBestAttempts,
    flaggedUsed: report.flaggedUsed,
    keptSource: report.keptSource,
  });
  book = await app.projects.saveBook(pid, {
    ...book,
    build: { builtAt: report.builtAt, fileName: report.fileName },
  });
  job.progress(1, 1, `Built ${report.fileName}`);
  app.events.changed(pid, "books", bookId);
}

export async function phase3Estimate(app: AppContext, pid: string, bookId: string) {
  const { env, prepared } = await preparedFor(app, pid, bookId, null);
  const results = await loadResults(app.paths, pid, bookId);
  const { plan } = prepared;
  const remaining = plan.chunks.filter((c) => !results.has(c.index));
  const staticTokens = Math.ceil(
    ((env.referenceKb?.length ?? 0) + (env.bookKb?.length ?? 0) + 4000) / 3.8,
  );
  const sourceTokens = remaining.reduce((s, c) => s + c.sourceTokens, 0);
  // Chapters mode also sends the story so far and, for long chapters, the
  // chapter around each part plus its translation so far.
  let contextTokens = 0;
  if (env.mode === "chapters") {
    const tokensOf = (keys: string[]) =>
      keys.reduce((n, k) => n + Math.ceil((prepared.units.get(k)?.text.length ?? 0) / 3.8) + 18, 0);
    for (const chunk of remaining) {
      const chapter = plan.chapters.find((c) => c.id === chunk.chapterId)!;
      contextTokens += Math.ceil(storySoFar(env, plan, chapter).join("\n").length / 3.8);
      const w = chapterWindow(prepared, chapter, chunk.unitKeys[0]!, chunk.unitKeys.at(-1)!);
      if (!w) continue;
      contextTokens += tokensOf(w.keys.slice(w.from, w.to));
      contextTokens += Math.round(tokensOf(w.keys.slice(w.from, w.first)) * 1.5);
    }
  }
  return {
    mode: env.mode ?? "chunks",
    chunks: plan.chunks.length,
    remaining: remaining.length,
    remainingChapters: plan.chapters.filter((c) => c.chunks.some((i) => !results.has(i))).length,
    sourceTokens,
    inputTokens: sourceTokens + contextTokens + remaining.length * (staticTokens + 600),
    cachedTokens: Math.max(0, remaining.length - 1) * staticTokens,
    outputTokens: Math.round(sourceTokens * 1.5),
  };
}
