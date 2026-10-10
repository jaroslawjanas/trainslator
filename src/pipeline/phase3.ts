import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  EXTRACTOR_VERSION,
  extractDocUnits,
  stripPlaceholders,
  type TransUnit,
} from "../epub/blocks.ts";
import type { EpubBook } from "../epub/book.ts";
import { unitAtOrAfter } from "../epub/flow.ts";
import { extractTocUnits } from "../epub/write.ts";
import { type CallTarget, callStructured, type LlmRuntime } from "../llm/call.ts";
import { isLlmError, LlmError } from "../llm/errors.ts";
import { jsonCandidates } from "../llm/response.ts";
import { estimateTokens, reasoningAllowance } from "../llm/tokens.ts";
import {
  PHASE3_PROMPT_VERSION,
  type Phase3Output,
  Phase3Output as Phase3OutputSchema,
  type Phase3Unit,
  phase3Blocks,
  phase3System,
  TocOutput,
  tocBlocks,
} from "../prompts/phase3.ts";
import { unicodeScriptsFor } from "../shared/languages.ts";
import { addUsage, emptyUsage, type Usage } from "../shared/schemas/common.ts";
import type { Segment } from "../shared/schemas/epub.ts";
import {
  ChunkResult,
  DocUnits,
  Glossary,
  type GlossaryTerm,
  Phase3Plan,
  type PlanChapter,
  type PlanChunk,
  TocTranslations,
  type UnitResult,
} from "../shared/schemas/translation.ts";
import { listDir, readJson, updateJson, writeJson } from "../store/json.ts";
import type { DataPaths } from "../store/paths.ts";
import { type CheckContext, checkChunk, checkUnitTranslation } from "./validate.ts";

export interface Phase3Languages {
  sourceLang: string;
  sourceName: string;
  targetLang: string;
  targetName: string;
  targetScript: string | null;
}

export interface Phase3Env {
  rt: LlmRuntime;
  paths: DataPaths;
  projectId: string;
  bookId: string;
  /** Model and settings for translating chunks. */
  target: CallTarget;
  /** Model and settings for the title/TOC step. */
  tocTarget: CallTarget;
  book: EpubBook;
  languages: Phase3Languages;
  languageNotes: string;
  referenceKb: string | null;
  bookKb: string | null;
  /** Chapter synopses from phase 2, keyed by segment id. */
  synopses: Map<string, string>;
  /** Chapters (segments at the chosen TOC depth). */
  segments: Segment[];
  keepDocs: Set<number>;
  /** Source tokens per chunk; default derived from the model's output limit. */
  chunkTokens?: number;
  signal?: AbortSignal;
  /** Called before each chunk; throws to stop at a chunk boundary (pause). */
  checkpoint?: () => void;
  onProgress?: (done: number, total: number, label: string) => void;
  onUsage?: (usage: Usage) => void;
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Expected output tokens per source token, by target script (rough). */
function expansionFor(script: string | null): number {
  switch (script) {
    case "Latn":
      return 1.35;
    case "Cyrl":
    case "Grek":
      return 1.8;
    case "Hans":
    case "Hant":
    case "Jpan":
    case "Kore":
      return 1.3;
    case "Arab":
    case "Hebr":
      return 1.6;
    default:
      return 2.5;
  }
}

export function defaultChunkTokens(env: Pick<Phase3Env, "target" | "languages" | "rt">): number {
  const { model, step } = env.target;
  const allowance = reasoningAllowance({
    enabled: step.reasoning.enabled,
    effort: step.reasoning.effort,
    budgetTokens: step.reasoning.budgetTokens,
    mode: model.reasoningMode,
    samples: env.rt.calibration.reasoningSamples(model.id, "phase3.translate"),
  });
  const cap =
    Math.min(model.maxOutputTokens, step.maxOutputTokens ?? Number.POSITIVE_INFINITY) - allowance;
  const perSource = expansionFor(env.languages.targetScript) * 1.2;
  return Math.max(300, Math.min(2500, Math.floor(Math.max(cap, 1000) / perSource)));
}

const UNIT_OVERHEAD_TOKENS = 18;

function unitTokens(u: TransUnit): number {
  return estimateTokens(u.text) + UNIT_OVERHEAD_TOKENS;
}

export interface PreparedPhase3 {
  plan: Phase3Plan;
  units: Map<string, TransUnit>;
  unitsByDoc: Map<number, TransUnit[]>;
  tocUnits: TransUnit[];
}

/** Extracts units for every document to translate and groups them into chapters and chunks. */
export async function preparePhase3(env: Phase3Env): Promise<PreparedPhase3> {
  const { book, paths, projectId, bookId } = env;
  const unitsByDoc = new Map<number, TransUnit[]>();
  for (const doc of book.docs) {
    if (env.keepDocs.has(doc.index)) continue;
    const units = extractDocUnits(book, doc.index);
    unitsByDoc.set(doc.index, units);
    await writeJson(paths.phase3Units(projectId, bookId, doc.index), DocUnits, {
      schemaVersion: 1,
      extractorVersion: EXTRACTOR_VERSION,
      docIndex: doc.index,
      path: doc.path,
      units,
    });
  }
  const tocUnits = extractTocUnits(book).filter(
    (u) => u.docIndex < 0 || !env.keepDocs.has(u.docIndex),
  );
  await writeJson(paths.phase3Units(projectId, bookId, 9999), DocUnits, {
    schemaVersion: 1,
    extractorVersion: EXTRACTOR_VERSION,
    docIndex: 9999,
    path: "(table of contents)",
    units: tocUnits,
  });

  // Which segment each flow unit belongs to.
  const segmentOf = new Map<string, Segment>();
  for (const seg of env.segments) {
    for (const r of seg.ranges)
      for (let i = r.fromUnit; i < r.toUnit; i++) segmentOf.set(`${r.docIndex}:${i}`, seg);
  }

  interface Placed {
    unit: TransUnit;
    order: number;
    segment: Segment | null;
  }
  const placed: Placed[] = [];
  for (const doc of book.docs) {
    const units = unitsByDoc.get(doc.index);
    if (!units) continue;
    const flow = book.doc(doc.index).flow;
    const docOrder = (doc.spinePos ?? 100_000 + doc.index) * 1_000_000;
    for (const u of units) {
      let pos: number;
      if (u.kind === "alt" && u.owner) pos = u.owner.unitIndex + 0.5;
      else if (u.kind === "alt") pos = unitAtOrAfter(flow.units, u.start) - 0.25;
      else pos = u.index;
      const flowIndex = Math.max(0, Math.ceil(pos === Math.floor(pos) ? pos : pos - 0.5));
      placed.push({
        unit: u,
        order: docOrder + pos,
        segment: segmentOf.get(`${doc.index}:${flowIndex}`) ?? null,
      });
    }
  }
  placed.sort((a, b) => a.order - b.order);

  const chunkTokens = env.chunkTokens ?? defaultChunkTokens(env);
  const chapters: PlanChapter[] = [];
  const chunks: PlanChunk[] = [];
  const chapterFor = new Map<string, PlanChapter>();
  const current = new Map<string, PlanChunk>();
  for (const { unit, segment } of placed) {
    if (!unit.translate) continue;
    const chapterId = segment ? segment.id : `doc${unit.docIndex}`;
    let chapter = chapterFor.get(chapterId);
    if (!chapter) {
      chapter = {
        id: chapterId,
        title: segment ? segment.title : `Other text in ${unit.file.split("/").pop()}`,
        segmentId: segment?.id ?? null,
        chunks: [],
      };
      chapterFor.set(chapterId, chapter);
      chapters.push(chapter);
    }
    const tokens = unitTokens(unit);
    let chunk = current.get(chapterId);
    if (
      !chunk ||
      (chunk.unitKeys.length > 0 &&
        (chunk.sourceTokens + tokens > chunkTokens || chunk.unitKeys.length >= 80))
    ) {
      chunk = { index: chunks.length, chapterId, unitKeys: [], sourceTokens: 0 };
      chunks.push(chunk);
      chapter.chunks.push(chunk.index);
      current.set(chapterId, chunk);
    }
    chunk.unitKeys.push(unit.key);
    chunk.sourceTokens += tokens;
  }

  const plan = await writeJson(paths.phase3Plan(projectId, bookId), Phase3Plan, {
    schemaVersion: 1,
    extractorVersion: EXTRACTOR_VERSION,
    chunkTokens,
    chapters,
    chunks,
    tocUnitKeys: tocUnits.filter((u) => u.translate).map((u) => u.key),
    createdAt: new Date().toISOString(),
  });
  const units = new Map<string, TransUnit>();
  for (const list of unitsByDoc.values()) for (const u of list) units.set(u.key, u);
  for (const u of tocUnits) units.set(u.key, u);
  return { plan, units, unitsByDoc, tocUnits };
}

// ---------------------------------------------------------------------------
// Translating
// ---------------------------------------------------------------------------

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Hash of everything static that shapes a chunk's translation (not the glossary or previous text). */
export function chunkInputsHash(
  env: Phase3Env,
  chunk: PlanChunk,
  units: Map<string, TransUnit>,
  synopsis: string | null,
): string {
  const { model, step } = env.target;
  return sha(
    JSON.stringify([
      PHASE3_PROMPT_VERSION,
      phase3System(
        env.languages.sourceName,
        env.languages.targetName,
        env.languages.targetLang,
        env.languageNotes,
      ),
      env.referenceKb,
      env.bookKb,
      synopsis,
      model.id,
      model.modelName,
      step,
      chunk.unitKeys.map((k) => [k, units.get(k)?.text]),
    ]),
  );
}

export async function loadResults(
  paths: DataPaths,
  projectId: string,
  bookId: string,
): Promise<Map<number, ChunkResult>> {
  const out = new Map<number, ChunkResult>();
  for (const name of await listDir(paths.phase3ResultsDir(projectId, bookId))) {
    const m = /^c(\d+)\.json$/.exec(name);
    if (!m) continue;
    const r = await readJson(
      paths.phase3Result(projectId, bookId, Number(m[1])),
      ChunkResult,
    ).catch(() => undefined);
    if (r) out.set(r.chunkIndex, r);
  }
  return out;
}

function normalizeTerm(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

interface RunState {
  env: Phase3Env;
  prepared: PreparedPhase3;
  results: Map<number, ChunkResult>;
  glossary: GlossaryTerm[];
  glossaryFile: string;
  ratios: number[];
  done: number;
  total: number;
  usage: Usage;
}

function medianRatio(state: RunState): number {
  if (state.ratios.length < 5) return 1;
  const sorted = [...state.ratios].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function checkContext(state: RunState): CheckContext {
  return {
    targetScripts: unicodeScriptsFor(state.env.languages.targetScript),
    ratio: medianRatio(state),
  };
}

function previousContext(
  state: RunState,
  chapter: PlanChapter,
  chunkIndex: number,
): { source: string; translation: string }[] {
  const pos = chapter.chunks.indexOf(chunkIndex);
  if (pos <= 0) return [];
  const prev = state.results.get(chapter.chunks[pos - 1]!);
  if (!prev) return [];
  return prev.units
    .filter((u) => u.text)
    .slice(-3)
    .map((u) => ({
      source: stripPlaceholders(state.prepared.units.get(u.key)?.text ?? ""),
      translation: stripPlaceholders(u.text ?? ""),
    }))
    .filter((p) => p.source.trim());
}

function toPromptUnits(units: TransUnit[]): {
  ids: Map<string, TransUnit>;
  promptUnits: Phase3Unit[];
} {
  const ids = new Map<string, TransUnit>();
  const promptUnits: Phase3Unit[] = units.map((u, i) => {
    const id = `u${i + 1}`;
    ids.set(id, u);
    return {
      id,
      text: u.text,
      keep: u.placeholders
        .filter((p) => p.required)
        .map((p) => (p.kind === "x" ? `x${p.n}` : `g${p.n}`)),
    };
  });
  return { ids, promptUnits };
}

/** Translates a list of units in one request (with repair turns); returns per-unit results. */
async function requestUnits(
  state: RunState,
  chapter: PlanChapter,
  chunk: PlanChunk,
  units: TransUnit[],
  previous: { source: string; translation: string }[],
  options: { useCache: boolean; instruction: string | null; label: string; salvage?: boolean },
): Promise<{ results: UnitResult[]; coined: Phase3Output["coined"] }> {
  const env = state.env;
  const { ids, promptUnits } = toPromptUnits(units);
  const synopsis = chapter.segmentId ? (env.synopses.get(chapter.segmentId) ?? null) : null;
  const blocks = phase3Blocks({
    sourceName: env.languages.sourceName,
    targetName: env.languages.targetName,
    targetTag: env.languages.targetLang,
    languageNotes: env.languageNotes,
    referenceKb: env.referenceKb,
    bookKb: env.bookKb,
    glossary: state.glossary.map((g) => ({ source: g.source, target: g.target, note: g.note })),
    synopsis,
    previous,
    units: promptUnits,
    instruction: options.instruction,
  });
  const requested = [...ids].map(([id, unit]) => ({ id, unit }));
  const expansion = expansionFor(env.languages.targetScript);
  const sourceTokens = units.reduce((s, u) => s + unitTokens(u), 0);
  const answerBudget = Math.ceil(sourceTokens * expansion * 1.15 + 40 * units.length + 150);
  const ctx = checkContext(state);

  try {
    const result = await callStructured(env.rt, env.target, {
      projectId: env.projectId,
      step: "phase3.translate",
      label: options.label,
      blocks,
      schema: Phase3OutputSchema as z.ZodType<Phase3Output>,
      schemaName: "translation",
      answerBudget,
      validate: (out) => checkChunk(requested, out.units, ctx).problems,
      promptCacheKey: `${env.projectId}:phase3`,
      useCache: options.useCache,
      signal: env.signal,
      onUsage: (u) => {
        state.usage = addUsage(state.usage, u);
        env.onUsage?.(u);
      },
    });
    const check = checkChunk(requested, result.value.units, ctx);
    const byId = new Map(result.value.units.map((u) => [u.id, u.text]));
    return {
      results: requested.map(({ id, unit }) => ({
        key: unit.key,
        text: byId.get(id) ?? null,
        status: "ok" as const,
        warnings: check.perUnit.get(id)?.warnings ?? [],
        errors: [],
      })),
      coined: result.value.coined,
    };
  } catch (error) {
    if (!isLlmError(error)) throw error;
    if (error.kind === "truncated" && units.length > 1) {
      const half = Math.ceil(units.length / 2);
      const first = await requestUnits(state, chapter, chunk, units.slice(0, half), previous, {
        ...options,
        label: `${options.label} (part 1)`,
      });
      const lastOfFirst = first.results
        .filter((r) => r.text)
        .slice(-3)
        .map((r) => ({
          source: stripPlaceholders(state.prepared.units.get(r.key)?.text ?? ""),
          translation: stripPlaceholders(r.text ?? ""),
        }));
      const second = await requestUnits(state, chapter, chunk, units.slice(half), lastOfFirst, {
        ...options,
        label: `${options.label} (part 2)`,
      });
      return {
        results: [...first.results, ...second.results],
        coined: [...first.coined, ...second.coined],
      };
    }
    if (error.kind === "truncated") {
      return {
        results: units.map((u) => ({
          key: u.key,
          text: null,
          status: "flagged",
          warnings: [],
          errors: ["too long for one answer"],
        })),
        coined: [],
      };
    }
    if (error.kind === "refusal") {
      return {
        results: units.map((u) => ({
          key: u.key,
          text: null,
          status: "refused",
          warnings: [],
          errors: [error.message],
        })),
        coined: [],
      };
    }
    if (error.kind === "invalid_output") {
      if (options.salvage === false || units.length === 1) {
        const best = bestAttempts(state, requested, error);
        return {
          results: requested.map(({ unit }) => ({
            key: unit.key,
            text: best.get(unit.key)?.text ?? null,
            status: "flagged",
            warnings: [],
            errors: best.get(unit.key)?.errors.length
              ? best.get(unit.key)!.errors
              : ["no valid translation was returned"],
          })),
          coined: [],
        };
      }
      return salvage(state, chapter, chunk, requested, error, previous, options);
    }
    throw error;
  }
}

/** Per-unit texts from an invalid answer, with their problems. */
function bestAttempts(
  state: RunState,
  requested: { id: string; unit: TransUnit }[],
  error: LlmError,
): Map<string, { text: string; errors: string[] }> {
  const ctx = checkContext(state);
  const best = new Map<string, { text: string; errors: string[] }>();
  for (const candidate of jsonCandidates(error.raw ?? "")) {
    const parsed = Phase3OutputSchema.safeParse(candidate);
    const list = parsed.success
      ? parsed.data.units
      : Array.isArray((candidate as { units?: unknown }).units)
        ? (candidate as { units: unknown[] }).units.filter(
            (u): u is { id: string; text: string } =>
              typeof u === "object" &&
              u !== null &&
              typeof (u as { id?: unknown }).id === "string" &&
              typeof (u as { text?: unknown }).text === "string",
          )
        : [];
    for (const o of list) {
      const req = requested.find((r) => r.id === o.id);
      if (!req || best.has(req.unit.key)) continue;
      best.set(req.unit.key, {
        text: o.text,
        errors: checkUnitTranslation(req.unit, o.text, ctx).errors,
      });
    }
    if (best.size > 0) break;
  }
  return best;
}

/** Keeps the valid units of an invalid answer and retries only the others alone, then flags what's left. */
async function salvage(
  state: RunState,
  chapter: PlanChapter,
  chunk: PlanChunk,
  requested: { id: string; unit: TransUnit }[],
  error: LlmError,
  previous: { source: string; translation: string }[],
  options: { useCache: boolean; instruction: string | null; label: string },
): Promise<{ results: UnitResult[]; coined: Phase3Output["coined"] }> {
  const ctx = checkContext(state);
  const best = bestAttempts(state, requested, error);
  const results = new Map<string, UnitResult>();
  let pending: TransUnit[] = [];
  for (const { unit } of requested) {
    const b = best.get(unit.key);
    if (b && b.errors.length === 0) {
      results.set(unit.key, {
        key: unit.key,
        text: b.text,
        status: "ok",
        warnings: checkUnitTranslation(unit, b.text, ctx).warnings,
        errors: [],
      });
    } else {
      pending.push(unit);
    }
  }
  for (let round = 1; round <= 1 && pending.length > 0; round++) {
    state.env.log?.(`Retrying ${pending.length} unit(s) of ${options.label} on their own.`);
    const retried: TransUnit[] = [];
    for (const unit of pending) {
      try {
        const r = await requestUnits(state, chapter, chunk, [unit], previous, {
          ...options,
          useCache: false,
          salvage: false,
          label: `${options.label} (retry ${unit.key})`,
        });
        const res = r.results[0]!;
        if (res.status === "ok" && res.text !== null) results.set(unit.key, res);
        else {
          if (res.text !== null) best.set(unit.key, { text: res.text, errors: res.errors });
          if (res.status === "refused") results.set(unit.key, res);
          else retried.push(unit);
        }
      } catch (e) {
        if (
          !isLlmError(e) ||
          e.kind === "aborted" ||
          e.kind === "auth" ||
          e.kind === "context_overflow"
        )
          throw e;
        retried.push(unit);
      }
    }
    pending = retried.filter((u) => !results.has(u.key));
  }
  for (const unit of pending) {
    const b = best.get(unit.key);
    results.set(unit.key, {
      key: unit.key,
      text: b?.text ?? null,
      status: "flagged",
      warnings: [],
      errors: b?.errors.length ? b.errors : ["no valid translation was returned"],
    });
  }
  return { results: requested.map(({ unit }) => results.get(unit.key)!), coined: [] };
}

async function addCoined(
  state: RunState,
  coined: Phase3Output["coined"],
  chunkIndex: number,
): Promise<void> {
  if (coined.length === 0) return;
  const updated = await updateJson(
    state.glossaryFile,
    Glossary,
    () => ({ schemaVersion: 1 as const, terms: [] }),
    (g) => {
      const terms = [...g.terms];
      for (const c of coined) {
        const key = normalizeTerm(c.source);
        if (!key || !c.target.trim()) continue;
        const existing = terms.find((t) => normalizeTerm(t.source) === key);
        if (!existing) terms.push({ ...c, chunkIndex, conflict: null });
        else if (normalizeTerm(existing.target) !== normalizeTerm(c.target) && !existing.conflict) {
          existing.conflict = `chunk ${chunkIndex} used "${c.target}"`;
        }
      }
      return { schemaVersion: 1 as const, terms };
    },
  );
  state.glossary = updated.terms;
}

async function translateChunk(
  state: RunState,
  chapter: PlanChapter,
  chunk: PlanChunk,
  options: { useCache: boolean; instruction: string | null },
): Promise<ChunkResult> {
  const env = state.env;
  const units = chunk.unitKeys
    .map((k) => state.prepared.units.get(k))
    .filter((u): u is TransUnit => u !== undefined);
  const before = state.usage;
  const previous = previousContext(state, chapter, chunk.index);
  const { results, coined } = await requestUnits(state, chapter, chunk, units, previous, {
    ...options,
    label: `chunk ${chunk.index + 1} · ${chapter.title}`.slice(0, 120),
  });
  for (const r of results) {
    const unit = state.prepared.units.get(r.key);
    if (r.status === "ok" && r.text && unit) {
      const s = stripPlaceholders(unit.text).length;
      if (s >= 40) state.ratios.push(stripPlaceholders(r.text).length / s);
    }
  }
  await addCoined(state, coined, chunk.index);
  const synopsis = chapter.segmentId ? (env.synopses.get(chapter.segmentId) ?? null) : null;
  const old = state.results.get(chunk.index);
  const usageDelta = {
    ...state.usage,
    calls: state.usage.calls - before.calls,
    promptTokens: state.usage.promptTokens - before.promptTokens,
    cachedTokens: state.usage.cachedTokens - before.cachedTokens,
    cacheWriteTokens: state.usage.cacheWriteTokens - before.cacheWriteTokens,
    completionTokens: state.usage.completionTokens - before.completionTokens,
    reasoningTokens: state.usage.reasoningTokens - before.reasoningTokens,
    cost: state.usage.cost === null ? null : state.usage.cost - (before.cost ?? 0),
  };
  const result = await writeJson(
    env.paths.phase3Result(env.projectId, env.bookId, chunk.index),
    ChunkResult,
    {
      schemaVersion: 1,
      chunkIndex: chunk.index,
      chapterId: chapter.id,
      inputsHash: chunkInputsHash(env, chunk, state.prepared.units, synopsis),
      promptVersion: PHASE3_PROMPT_VERSION,
      modelId: env.target.model.id,
      instruction: options.instruction,
      finishedAt: new Date().toISOString(),
      usage: usageDelta,
      units: results,
      history: old ? [...old.history, { at: old.finishedAt, units: old.units }].slice(-10) : [],
    },
  );
  state.results.set(chunk.index, result);
  return result;
}

export interface Phase3Summary {
  chunks: number;
  translatedChunks: number;
  units: number;
  ok: number;
  flagged: number;
  refused: number;
  usage: Usage;
}

/**
 * Translates every chunk that has no result yet. Chapters run in parallel
 * (the limiter caps requests); chunks inside a chapter run in order because
 * each uses the end of the previous one as context.
 */
export async function runPhase3(env: Phase3Env, prepared?: PreparedPhase3): Promise<Phase3Summary> {
  const p = prepared ?? (await preparePhase3(env));
  const glossaryFile = env.paths.phase3Glossary(env.projectId, env.bookId);
  const glossary = (await readJson(glossaryFile, Glossary).catch(() => undefined))?.terms ?? [];
  const state: RunState = {
    env,
    prepared: p,
    results: await loadResults(env.paths, env.projectId, env.bookId),
    glossary,
    glossaryFile,
    ratios: [],
    done: 0,
    total: p.plan.chunks.length,
    usage: emptyUsage(),
  };
  state.done = p.plan.chunks.filter((c) => state.results.has(c.index)).length;
  const report = (label: string) => env.onProgress?.(state.done, state.total, label);
  report("Starting translation");

  const todo = p.plan.chapters
    .map((chapter) => ({
      chapter,
      chunks: chapter.chunks
        .map((i) => p.plan.chunks[i]!)
        .filter((c) => !state.results.has(c.index)),
    }))
    .filter((c) => c.chunks.length > 0);
  let translated = 0;

  const runChapter = async (chapter: PlanChapter, chunks: PlanChunk[]) => {
    for (const chunk of chunks) {
      if (env.signal?.aborted) throw new LlmError("aborted", "Cancelled");
      env.checkpoint?.();
      await translateChunk(state, chapter, chunk, { useCache: true, instruction: null });
      translated++;
      state.done++;
      report(chapter.title);
    }
  };

  // Warm the prompt cache with one request before fanning out.
  const first = todo[0];
  if (first) {
    const [firstChunk, ...rest] = first.chunks;
    await runChapter(first.chapter, [firstChunk!]);
    first.chunks = rest;
  }
  const results = await Promise.allSettled(
    todo.filter((t) => t.chunks.length > 0).map((t) => runChapter(t.chapter, t.chunks)),
  );
  const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;

  let ok = 0;
  let flagged = 0;
  let refused = 0;
  for (const r of state.results.values()) {
    for (const u of r.units) {
      if (u.status === "ok") ok++;
      else if (u.status === "flagged") flagged++;
      else refused++;
    }
  }
  return {
    chunks: p.plan.chunks.length,
    translatedChunks: translated,
    units: ok + flagged + refused,
    ok,
    flagged,
    refused,
    usage: state.usage,
  };
}

/** Re-translates one chunk (optionally with an instruction), bypassing the response cache. */
export async function retranslateChunk(
  env: Phase3Env,
  prepared: PreparedPhase3,
  chunkIndex: number,
  instruction: string | null,
): Promise<ChunkResult> {
  const chunk = prepared.plan.chunks[chunkIndex];
  if (!chunk) throw new Error(`No chunk ${chunkIndex}`);
  const chapter = prepared.plan.chapters.find((c) => c.id === chunk.chapterId)!;
  const glossaryFile = env.paths.phase3Glossary(env.projectId, env.bookId);
  const state: RunState = {
    env,
    prepared,
    results: await loadResults(env.paths, env.projectId, env.bookId),
    glossary: (await readJson(glossaryFile, Glossary).catch(() => undefined))?.terms ?? [],
    glossaryFile,
    ratios: [],
    done: 0,
    total: 1,
    usage: emptyUsage(),
  };
  return translateChunk(state, chapter, chunk, { useCache: false, instruction });
}

/** Re-translates a single unit and updates the chunk result in place. */
export async function retranslateUnit(
  env: Phase3Env,
  prepared: PreparedPhase3,
  unitKey: string,
  instruction: string | null,
): Promise<UnitResult> {
  const chunk = prepared.plan.chunks.find((c) => c.unitKeys.includes(unitKey));
  const unit = prepared.units.get(unitKey);
  if (!chunk || !unit) throw new Error(`Unknown unit ${unitKey}`);
  const chapter = prepared.plan.chapters.find((c) => c.id === chunk.chapterId)!;
  const glossaryFile = env.paths.phase3Glossary(env.projectId, env.bookId);
  const results = await loadResults(env.paths, env.projectId, env.bookId);
  const state: RunState = {
    env,
    prepared,
    results,
    glossary: (await readJson(glossaryFile, Glossary).catch(() => undefined))?.terms ?? [],
    glossaryFile,
    ratios: [],
    done: 0,
    total: 1,
    usage: emptyUsage(),
  };
  const pos = chunk.unitKeys.indexOf(unitKey);
  const existing = results.get(chunk.index);
  const previous = (existing?.units ?? [])
    .slice(Math.max(0, pos - 3), pos)
    .filter((u) => u.text)
    .map((u) => ({
      source: stripPlaceholders(prepared.units.get(u.key)?.text ?? ""),
      translation: stripPlaceholders(u.text ?? ""),
    }));
  const { results: out } = await requestUnits(state, chapter, chunk, [unit], previous, {
    useCache: false,
    instruction,
    label: `re-translate ${unitKey}`,
  });
  const result = out[0]!;
  if (existing) {
    await updateJson(
      env.paths.phase3Result(env.projectId, env.bookId, chunk.index),
      ChunkResult,
      () => existing,
      (r) => ({
        ...r,
        history: [...r.history, { at: r.finishedAt, units: r.units }].slice(-10),
        finishedAt: new Date().toISOString(),
        units: r.units.map((u) => (u.key === unitKey ? result : u)),
      }),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Title and table of contents
// ---------------------------------------------------------------------------

function normalizeLabel(s: string): string {
  return stripPlaceholders(s).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Translates TOC labels (reusing heading translations where the text matches) and the book title. */
export async function translateToc(env: Phase3Env, prepared: PreparedPhase3): Promise<void> {
  const results = await loadResults(env.paths, env.projectId, env.bookId);
  const translated = new Map<string, string>();
  for (const r of results.values())
    for (const u of r.units) if (u.text && u.status === "ok") translated.set(u.key, u.text);

  // Headings by normalized source text.
  const headingByText = new Map<string, string>();
  const headingPairs: { source: string; translation: string }[] = [];
  for (const u of prepared.units.values()) {
    if (u.kind !== "text" || (u.role !== "heading" && u.role !== "title")) continue;
    const t = translated.get(u.key);
    if (!t) continue;
    const key = normalizeLabel(u.text);
    if (!headingByText.has(key)) {
      headingByText.set(key, t);
      if (u.role === "heading")
        headingPairs.push({
          source: stripPlaceholders(u.text),
          translation: stripPlaceholders(t.replace(/<x\d+\/>/g, " ")),
        });
    }
  }

  const items: Record<string, string> = {};
  const sources: Record<string, "heading" | "ai" | "edited"> = {};
  const ask: TransUnit[] = [];
  for (const u of prepared.tocUnits) {
    if (!u.translate) continue;
    const reuse = headingByText.get(normalizeLabel(u.text));
    if (reuse && u.placeholders.length === 0) {
      items[u.key] = stripPlaceholders(reuse.replace(/<x\d+\/>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      sources[u.key] = "heading";
    } else {
      ask.push(u);
    }
  }

  const titleSource = env.book.title;
  const titleUnit: TransUnit = {
    key: "title",
    file: "",
    docIndex: -1,
    index: -1,
    kind: "toc",
    role: "toc",
    headingLevel: 0,
    inFootnote: false,
    text: titleSource,
    translate: true,
    skipReason: null,
    placeholders: [],
    prefix: "",
    suffix: "",
    dropCap: null,
    pre: false,
    start: 0,
    end: 0,
    quote: null,
    owner: null,
    notes: [],
  };
  const all = [titleUnit, ...ask];
  const { ids, promptUnits } = toPromptUnits(all);
  const requested = [...ids].map(([id, unit]) => ({ id, unit }));
  const ctx: CheckContext = {
    targetScripts: unicodeScriptsFor(env.languages.targetScript),
    ratio: 1,
  };
  const result = await callStructured(env.rt, env.tocTarget, {
    projectId: env.projectId,
    step: "utility",
    label: "title and table of contents",
    blocks: tocBlocks({
      sourceName: env.languages.sourceName,
      targetName: env.languages.targetName,
      targetTag: env.languages.targetLang,
      languageNotes: env.languageNotes,
      bookKb: env.bookKb,
      headings: headingPairs.slice(0, 300),
      items: promptUnits,
    }),
    schema: TocOutput,
    schemaName: "toc",
    answerBudget: Math.ceil(all.reduce((s, u) => s + unitTokens(u), 0) * 2 + 200),
    validate: (out) => checkChunk(requested, out.items, ctx).problems,
    signal: env.signal,
    onUsage: env.onUsage,
  });
  const byId = new Map(result.value.items.map((i) => [i.id, i.text]));
  let title: string | null = null;
  for (const [id, unit] of ids) {
    const text = byId.get(id);
    if (!text) continue;
    if (unit.key === "title") title = text;
    else {
      items[unit.key] = text;
      sources[unit.key] = "ai";
    }
  }
  await writeJson(env.paths.phase3Toc(env.projectId, env.bookId), TocTranslations, {
    schemaVersion: 1,
    title,
    items,
    sources,
    finishedAt: new Date().toISOString(),
  });
}
