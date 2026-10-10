import { EpubBook } from "../epub/book.ts";
import { computeStructure } from "../epub/structure.ts";
import { renderRangesMarkdown } from "../epub/text.ts";
import { callStructured } from "../llm/call.ts";
import {
  aiAlignmentProblems,
  alignmentRatio,
  checkAlignment,
  fromAiAlignment,
  proposeAlignment,
} from "../pipeline/alignment.ts";
import { AlignOutput, alignBlocks } from "../prompts/alignment.ts";
import type { AppContext } from "../server/context.ts";
import { Alignment } from "../shared/schemas/alignment.ts";
import { newId, nowIso } from "../shared/schemas/common.ts";
import { EpubStructure, type Segment } from "../shared/schemas/epub.ts";
import type { Pair } from "../shared/schemas/project.ts";
import { readJson, removePath, writeFileAtomic, writeJson } from "../store/json.ts";
import { NotFoundError, UserError } from "./projects.ts";

export function safeFileName(name: string): string {
  const cleaned = [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch))
    .join("");
  return cleaned.slice(0, 200) || "book.epub";
}

export function segmentsAt(structure: EpubStructure, depth: number): Segment[] {
  const d = Math.max(1, Math.min(structure.maxDepth, depth));
  return structure.segmentsByDepth[String(d)] ?? [];
}

export async function loadStructure(
  app: AppContext,
  pid: string,
  pairId: string,
  side: "source" | "target",
): Promise<EpubStructure> {
  const s = await readJson(app.paths.pairStructure(pid, pairId, side), EpubStructure);
  if (!s) throw new NotFoundError("Book structure");
  return s;
}

export async function loadAlignment(
  app: AppContext,
  pid: string,
  pairId: string,
): Promise<Alignment> {
  const a = await readJson(app.paths.alignment(pid, pairId), Alignment);
  if (!a) throw new NotFoundError("Alignment");
  return a;
}

/** Imports an English book and its human translation, computes structures and a first alignment. */
export async function importPair(
  app: AppContext,
  pid: string,
  files: {
    source: { name: string; bytes: Uint8Array };
    target: { name: string; bytes: Uint8Array };
  },
): Promise<Pair> {
  const project = await app.projects.get(pid);
  const source = EpubBook.open(files.source.bytes);
  const target = EpubBook.open(files.target.bytes);
  const sourceStructure = computeStructure(source, project.sourceLang);
  const targetStructure = computeStructure(target, project.targetLang);
  if (sourceStructure.totalWords === 0)
    throw new UserError("The English book seems to have no text.");
  if (targetStructure.totalWords === 0)
    throw new UserError("The translated book seems to have no text.");

  const pair: Pair = {
    schemaVersion: 1,
    id: newId("pair"),
    title: source.title,
    sourceFileName: safeFileName(files.source.name),
    targetFileName: safeFileName(files.target.name),
    createdAt: nowIso(),
    phase1: { state: "none", finishedAt: null, entries: null },
  };
  await writeFileAtomic(app.paths.pairEpub(pid, pair.id, "source"), files.source.bytes);
  await writeFileAtomic(app.paths.pairEpub(pid, pair.id, "target"), files.target.bytes);
  await writeJson(app.paths.pairStructure(pid, pair.id, "source"), EpubStructure, sourceStructure);
  await writeJson(app.paths.pairStructure(pid, pair.id, "target"), EpubStructure, targetStructure);
  const depths = { source: sourceStructure.maxDepth, target: targetStructure.maxDepth };
  const alignment = proposeAlignment(
    segmentsAt(sourceStructure, depths.source),
    segmentsAt(targetStructure, depths.target),
    depths,
  );
  await writeJson(app.paths.alignment(pid, pair.id), Alignment, alignment);
  await app.projects.savePair(pid, pair);
  await app.projects.touch(pid);
  return pair;
}

export async function pairDetail(app: AppContext, pid: string, pairId: string) {
  const pair = await app.projects.pair(pid, pairId);
  const [source, target, alignment] = await Promise.all([
    loadStructure(app, pid, pairId, "source"),
    loadStructure(app, pid, pairId, "target"),
    loadAlignment(app, pid, pairId),
  ]);
  return {
    pair,
    source,
    target,
    alignment,
    ratio: alignmentRatio(
      alignment,
      segmentsAt(source, alignment.tocDepthSource),
      segmentsAt(target, alignment.tocDepthTarget),
    ),
  };
}

export async function saveAlignment(
  app: AppContext,
  pid: string,
  pairId: string,
  alignment: Alignment,
): Promise<Alignment> {
  const source = await loadStructure(app, pid, pairId, "source");
  const target = await loadStructure(app, pid, pairId, "target");
  const problems = checkAlignment(
    alignment,
    segmentsAt(source, alignment.tocDepthSource),
    segmentsAt(target, alignment.tocDepthTarget),
  );
  if (problems.length > 0)
    throw new UserError(`The alignment isn't valid: ${problems.slice(0, 3).join("; ")}`);
  return writeJson(app.paths.alignment(pid, pairId), Alignment, alignment);
}

export async function reproposeAlignment(
  app: AppContext,
  pid: string,
  pairId: string,
  depths: { source: number; target: number },
): Promise<Alignment> {
  const source = await loadStructure(app, pid, pairId, "source");
  const target = await loadStructure(app, pid, pairId, "target");
  const alignment = proposeAlignment(
    segmentsAt(source, depths.source),
    segmentsAt(target, depths.target),
    depths,
  );
  return writeJson(app.paths.alignment(pid, pairId), Alignment, alignment);
}

/** Asks the utility model to match the chapters by their titles, openings and lengths. */
export async function aiProposeAlignment(
  app: AppContext,
  pid: string,
  pairId: string,
  depths: { source: number; target: number },
): Promise<Alignment> {
  const project = await app.projects.get(pid);
  const source = segmentsAt(await loadStructure(app, pid, pairId, "source"), depths.source);
  const target = segmentsAt(await loadStructure(app, pid, pairId, "target"), depths.target);
  if (source.length === 0 || target.length === 0)
    throw new UserError("One of the books has no segments at this depth.");
  const result = await callStructured(app.rt, app.settings.target("utility"), {
    projectId: pid,
    step: "utility",
    label: "alignment proposal",
    blocks: alignBlocks(project.targetLangName, source, target),
    schema: AlignOutput,
    schemaName: "alignment",
    answerBudget: 400 + (source.length + target.length) * 25,
    validate: (v) => aiAlignmentProblems(v.units, source.length, target.length),
    lane: "interactive",
  });
  const alignment = fromAiAlignment(result.value.units, source, target, depths);
  return writeJson(app.paths.alignment(pid, pairId), Alignment, alignment);
}

/** Start and end of both sides of an alignment unit, as Markdown, for checking a match. */
export async function unitPreview(
  app: AppContext,
  pid: string,
  pairId: string,
  unitId: string,
  chars = 1500,
) {
  const alignment = await loadAlignment(app, pid, pairId);
  const unit = alignment.units.find((u) => u.id === unitId);
  if (!unit) throw new NotFoundError("Alignment unit");
  const side = async (which: "source" | "target", ids: string[], depth: number) => {
    const structure = await loadStructure(app, pid, pairId, which);
    const segs = segmentsAt(structure, depth).filter((s) => ids.includes(s.id));
    const book = await app.books.open(app.paths.pairEpub(pid, pairId, which));
    const text = renderRangesMarkdown(
      book,
      segs.flatMap((s) => s.ranges),
    );
    return {
      titles: segs.map((s) => s.title),
      words: segs.reduce((s, x) => s + x.words, 0),
      start: text.slice(0, chars),
      end: text.length > chars * 2 ? text.slice(-chars) : text.slice(chars, chars * 2),
      truncated: text.length > chars * 2,
    };
  };
  return {
    source: await side("source", unit.source, alignment.tocDepthSource),
    target: await side("target", unit.target, alignment.tocDepthTarget),
  };
}

export async function deletePair(app: AppContext, pid: string, pairId: string): Promise<void> {
  await app.projects.pair(pid, pairId);
  for (const side of ["source", "target"] as const)
    app.books.forget(app.paths.pairEpub(pid, pairId, side));
  await removePath(app.paths.pair(pid, pairId));
  for (const book of await app.projects.books(pid)) {
    if (book.pairIds.includes(pairId)) {
      await app.projects.saveBook(pid, {
        ...book,
        pairIds: book.pairIds.filter((id) => id !== pairId),
      });
    }
  }
}
