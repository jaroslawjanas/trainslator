import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EpubBook } from "../epub/book.ts";
import { computeStructure } from "../epub/structure.ts";
import { pairKbFromBook } from "../kb/from-book.ts";
import { identityAlignment, proposeAlignment } from "../pipeline/alignment.ts";
import type { AppContext } from "../server/context.ts";
import { Alignment } from "../shared/schemas/alignment.ts";
import { newId, nowIso } from "../shared/schemas/common.ts";
import { EpubStructure } from "../shared/schemas/epub.ts";
import { Kb, KbOverrides } from "../shared/schemas/kb.ts";
import type { Book, Pair } from "../shared/schemas/project.ts";
import { Glossary, type GlossaryTerm } from "../shared/schemas/translation.ts";
import { readJson, removePath, writeFileAtomic, writeJson } from "../store/json.ts";
import { deleteBook, loadBookStructure, loadSetup } from "./books.ts";
import { historyView, loadHistory } from "./history.ts";
import { loadKb } from "./kb.ts";
import { safeFileName, segmentsAt } from "./pairs.ts";
import { UserError } from "./projects.ts";
import { loadPlan } from "./translation.ts";

/**
 * A finished book as a reference pair: its original, its latest build as the
 * translation, and its knowledge base, so later books learn from it like
 * from a published translation. The book itself is left as it is.
 */

/** The book's latest build on disk, or null. */
export async function builtFile(app: AppContext, pid: string, book: Book): Promise<string | null> {
  if (!book.build.fileName) return null;
  const file = path.join(app.paths.outputDir(pid, book.id), book.build.fileName);
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

async function coinedTerms(app: AppContext, pid: string, bookId: string): Promise<GlossaryTerm[]> {
  return (
    (await readJson(app.paths.phase3Glossary(pid, bookId), Glossary).catch(() => undefined))
      ?.terms ?? []
  );
}

const ReportCounts = z.object({ untranslatedUnits: z.number().int() });

/** What making a pair from the book would take along, for the confirmation. */
export async function referencePairPreview(app: AppContext, pid: string, bookId: string) {
  const project = await app.projects.get(pid);
  const book = await app.projects.book(pid, bookId);
  const file = await builtFile(app, pid, book);
  const { kb, overrides } = await loadKb(app, { kind: "book", pid, id: bookId });
  const dry = pairKbFromBook({
    kb,
    overrides,
    title: book.title,
    lang: project.sourceLang,
    unitOf: new Map(),
    coined: await coinedTerms(app, pid, bookId),
    segmentOfChunk: new Map(),
    now: nowIso(),
  });

  // The build is current when it was made from the translation as it is now.
  let buildCurrent: boolean | null = null;
  let untranslated = 0;
  if (file) {
    const lastBuild = (await loadHistory(app, pid, bookId)).builds.at(-1);
    const savedAs = (await historyView(app, pid, bookId)).current?.savedAs ?? null;
    if (lastBuild?.translationId) buildCurrent = lastBuild.translationId === savedAs;
    const report = await readJson(app.paths.buildReport(pid, bookId), ReportCounts).catch(
      () => undefined,
    );
    untranslated = report?.untranslatedUnits ?? 0;
  }

  return {
    build: file ? { fileName: book.build.fileName, builtAt: book.build.builtAt } : null,
    buildCurrent,
    untranslated,
    kb: {
      entries: kb.entries.length,
      open: kb.entries.filter((e) => e.status === "open").length,
      yours: Object.values(overrides.entries).filter((o) => o.entry !== null).length,
    },
    coined: { left: dry.coinedAdded, conflicts: dry.coinedConflicts },
  };
}

export async function makeReferencePair(
  app: AppContext,
  pid: string,
  bookId: string,
  options: { mergeCoined: boolean; removeBook: boolean },
): Promise<Pair> {
  const project = await app.projects.get(pid);
  const book = await app.projects.book(pid, bookId);
  const file = await builtFile(app, pid, book);
  if (!file || !book.build.fileName)
    throw new UserError("Build the EPUB first: the pair's translation is the built book.");

  const sourceStructure = await loadBookStructure(app, pid, bookId);
  const targetBytes = await fs.readFile(file);
  const targetStructure = computeStructure(EpubBook.open(targetBytes), project.targetLang);

  // The knowledge base's refs are chapters at the setup's TOC level; the
  // build has the same chapters, so each one becomes a unit of its own.
  const setup = await loadSetup(app, pid, bookId);
  const depth = Math.max(1, Math.min(sourceStructure.maxDepth, setup.tocDepth));
  const identity = identityAlignment(
    segmentsAt(sourceStructure, depth),
    segmentsAt(targetStructure, depth),
    depth,
    new Set(setup.keepDocs),
  );
  const alignment =
    identity ??
    proposeAlignment(
      segmentsAt(sourceStructure, sourceStructure.maxDepth),
      segmentsAt(targetStructure, targetStructure.maxDepth),
      { source: sourceStructure.maxDepth, target: targetStructure.maxDepth },
      { languages: { source: project.sourceLang, target: project.targetLang } },
    );
  const unitOf = new Map(identity?.units.map((u) => [u.source[0]!, u.id]) ?? []);

  // Coined terms point at the chapter of the chunk they were coined in.
  const plan = await loadPlan(app, pid, bookId);
  const chapterSegment = new Map(
    (plan?.chapters ?? []).flatMap((c) => (c.segmentId ? [[c.id, c.segmentId] as const] : [])),
  );
  const segmentOfChunk = new Map(
    (plan?.chunks ?? []).flatMap((ch) => {
      const segment = chapterSegment.get(ch.chapterId);
      return segment ? [[ch.index, segment] as const] : [];
    }),
  );

  const now = nowIso();
  const { kb, overrides } = await loadKb(app, { kind: "book", pid, id: bookId });
  const converted = pairKbFromBook({
    kb,
    overrides,
    title: book.title,
    lang: project.sourceLang,
    unitOf,
    coined: options.mergeCoined ? await coinedTerms(app, pid, bookId) : null,
    segmentOfChunk,
    now,
  });
  const hasKb = converted.kb.entries.length > 0 || converted.kb.styleRules.length > 0;

  const pair: Pair = {
    schemaVersion: 1,
    id: newId("pair"),
    title: book.title,
    sourceFileName: book.sourceFileName,
    targetFileName: safeFileName(book.build.fileName),
    createdAt: now,
    phase1: hasKb
      ? { state: "done", finishedAt: now, entries: converted.kb.entries.length }
      : { state: "none", finishedAt: null, entries: null },
    fromBook: { bookId, title: book.title, madeAt: now },
  };
  try {
    const sourceBytes = await fs.readFile(app.paths.bookEpub(pid, bookId));
    await writeFileAtomic(app.paths.pairEpub(pid, pair.id, "source"), sourceBytes);
    await writeFileAtomic(app.paths.pairEpub(pid, pair.id, "target"), targetBytes);
    await writeJson(
      app.paths.pairStructure(pid, pair.id, "source"),
      EpubStructure,
      sourceStructure,
    );
    await writeJson(
      app.paths.pairStructure(pid, pair.id, "target"),
      EpubStructure,
      targetStructure,
    );
    await writeJson(app.paths.alignment(pid, pair.id), Alignment, alignment);
    if (hasKb) await writeJson(app.paths.pairKb(pid, pair.id), Kb, converted.kb);
    const ownChanges =
      Object.keys(converted.overrides.entries).length +
      Object.keys(converted.overrides.styleRules).length;
    if (ownChanges > 0)
      await writeJson(app.paths.pairKbOverrides(pid, pair.id), KbOverrides, converted.overrides);
    // Last, so a pair that failed halfway is never listed.
    await app.projects.savePair(pid, pair);
  } catch (error) {
    await removePath(app.paths.pair(pid, pair.id)).catch(() => undefined);
    throw error;
  }
  await app.projects.touch(pid);
  if (options.removeBook) await deleteBook(app, pid, bookId);
  return pair;
}
