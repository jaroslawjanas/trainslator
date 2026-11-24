import { extractUnit, stripPlaceholders } from "../epub/blocks.ts";
import { EpubBook } from "../epub/book.ts";
import type { UnitRole } from "../epub/flow.ts";
import { segmentUnits } from "../epub/segments.ts";
import { computeStructure } from "../epub/structure.ts";
import { sourceLanguage } from "../languages/index.ts";
import { callStructured } from "../llm/call.ts";
import {
  aiAlignmentProblems,
  alignmentRatio,
  checkAlignment,
  fromAiAlignment,
  proposeAlignment,
} from "../pipeline/alignment.ts";
import { matchPassages } from "../pipeline/passages.ts";
import { alignBlocks, alignOutputFor } from "../prompts/alignment.ts";
import type { AppContext } from "../server/context.ts";
import { Alignment } from "../shared/schemas/alignment.ts";
import { newId, nowIso } from "../shared/schemas/common.ts";
import { EpubStructure, type Segment, type UnitRange } from "../shared/schemas/epub.ts";
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

/** Imports a book and its human translation, computes structures and a first alignment. */
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
    throw new UserError("The original book seems to have no text.");
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
    fromBook: null,
    filesChangedAt: null,
    askAnew: false,
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
    { languages: { source: project.sourceLang, target: project.targetLang } },
  );
  await writeJson(app.paths.alignment(pid, pair.id), Alignment, alignment);
  await app.projects.savePair(pid, pair);
  await app.projects.touch(pid);
  return pair;
}

/** The pair as the app shows it: phase 1 is "stopped" if saved as running but no job runs. */
export function livePair(app: AppContext, pair: Pair): Pair {
  if (pair.phase1.state !== "running" || app.runner.activeFor(pair.id)) return pair;
  return { ...pair, phase1: { ...pair.phase1, state: "stopped" } };
}

export async function pairDetail(app: AppContext, pid: string, pairId: string) {
  const pair = livePair(app, await app.projects.pair(pid, pairId));
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
  const project = await app.projects.get(pid);
  const source = await loadStructure(app, pid, pairId, "source");
  const target = await loadStructure(app, pid, pairId, "target");
  const alignment = proposeAlignment(
    segmentsAt(source, depths.source),
    segmentsAt(target, depths.target),
    depths,
    { languages: { source: project.sourceLang, target: project.targetLang } },
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
    blocks: alignBlocks(sourceLanguage(project.sourceLang), project.targetLangName, source, target),
    schema: alignOutputFor(sourceLanguage(project.sourceLang)),
    schemaName: "alignment",
    answerBudget: 400 + (source.length + target.length) * 25,
    validate: (v) => aiAlignmentProblems(v.units, source.length, target.length),
    lane: "interactive",
  });
  const alignment = fromAiAlignment(result.value.units, source, target, depths);
  return writeJson(app.paths.alignment(pid, pairId), Alignment, alignment);
}

/** A passage of a pair's book, as Review shows passages: text with formatting tags. */
export interface ReadingPassage {
  role: UnitRole;
  inFootnote: boolean;
  text: string;
  placeholders: { n: number; kind: "g" | "x"; label: string; required: boolean }[];
}

function readingPassages(book: EpubBook, ranges: UnitRange[]): ReadingPassage[] {
  const out: ReadingPassage[] = [];
  for (const { docIndex, unit } of segmentUnits(book, ranges)) {
    if (unit.role === "title") continue;
    if (unit.kind === "break") {
      out.push({ role: "break", inFootnote: false, text: "* * *", placeholders: [] });
      continue;
    }
    const loaded = book.doc(docIndex);
    const extracted = extractUnit(loaded.src, unit, docIndex, loaded.info.path);
    if (!extracted.text.trim()) continue;
    out.push({
      role: unit.role,
      inFootnote: unit.inFootnote,
      text: extracted.text,
      placeholders: extracted.placeholders.map(({ n, kind, label, required }) => ({
        n,
        kind,
        label,
        required,
      })),
    });
  }
  return out;
}

/**
 * The text of some chapters of both books, for reading them side by side:
 * the passages, lined up by length and shared names.
 */
export async function pairText(
  app: AppContext,
  pid: string,
  pairId: string,
  chapters: { source: string[]; target: string[] },
) {
  const alignment = await loadAlignment(app, pid, pairId);
  const side = async (which: "source" | "target", ids: string[], depth: number) => {
    const byId = new Map(
      segmentsAt(await loadStructure(app, pid, pairId, which), depth).map((s) => [s.id, s]),
    );
    const segments = ids.map((id) => {
      const s = byId.get(id);
      if (!s) throw new UserError(`The chapters have changed; reload the page. (${id})`);
      return s;
    });
    const book = await app.books.open(app.paths.pairEpub(pid, pairId, which));
    return {
      titles: segments.map((s) => s.title),
      words: segments.reduce((sum, s) => sum + s.words, 0),
      passages: readingPassages(
        book,
        segments.flatMap((s) => s.ranges),
      ),
    };
  };
  const source = await side("source", chapters.source, alignment.tocDepthSource);
  const target = await side("target", chapters.target, alignment.tocDepthTarget);
  const plain = (p: ReadingPassage[]) => p.map((x) => stripPlaceholders(x.text));
  const rows = matchPassages(plain(source.passages), plain(target.passages));
  return {
    source: { titles: source.titles, words: source.words, passages: source.passages.length },
    target: { titles: target.titles, words: target.words, passages: target.passages.length },
    rows: rows.map((r) => ({
      source: r.source.map((i) => source.passages[i]!),
      target: r.target.map((i) => target.passages[i]!),
    })),
  };
}

/**
 * Puts another EPUB in place of one of the pair's books. The alignment is
 * proposed again and has to be confirmed; the knowledge base, your edits
 * and phase 1's saved reads stay until phase 1 runs again (a read is only
 * reused if the same row's text is unchanged). The pair keeps its title,
 * which books show in their reference knowledge.
 */
export async function replacePairFile(
  app: AppContext,
  pid: string,
  pairId: string,
  side: "source" | "target",
  file: { name: string; bytes: Uint8Array },
): Promise<Pair> {
  const project = await app.projects.get(pid);
  const pair = await app.projects.pair(pid, pairId);
  const structure = computeStructure(
    EpubBook.open(file.bytes),
    side === "source" ? project.sourceLang : project.targetLang,
  );
  if (structure.totalWords === 0)
    throw new UserError(
      side === "source"
        ? "The original book seems to have no text."
        : "The translated book seems to have no text.",
    );
  const other = await loadStructure(app, pid, pairId, side === "source" ? "target" : "source");
  const source = side === "source" ? structure : other;
  const target = side === "target" ? structure : other;

  const epub = app.paths.pairEpub(pid, pairId, side);
  await writeFileAtomic(epub, file.bytes);
  app.books.forget(epub);
  await writeJson(app.paths.pairStructure(pid, pairId, side), EpubStructure, structure);
  const depths = { source: source.maxDepth, target: target.maxDepth };
  await writeJson(
    app.paths.alignment(pid, pairId),
    Alignment,
    proposeAlignment(segmentsAt(source, depths.source), segmentsAt(target, depths.target), depths, {
      languages: { source: project.sourceLang, target: project.targetLang },
    }),
  );
  const saved = await app.projects.savePair(pid, {
    ...pair,
    ...(side === "source"
      ? { sourceFileName: safeFileName(file.name) }
      : { targetFileName: safeFileName(file.name) }),
    filesChangedAt: nowIso(),
  });
  await app.projects.touch(pid);
  return saved;
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
