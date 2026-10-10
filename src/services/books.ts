import { EpubBook } from "../epub/book.ts";
import { computeStructure } from "../epub/structure.ts";
import { selectReferenceKbs } from "../kb/select.ts";
import type { AppContext } from "../server/context.ts";
import { newId, nowIso } from "../shared/schemas/common.ts";
import { BookSetup, EpubStructure } from "../shared/schemas/epub.ts";
import { Kb } from "../shared/schemas/kb.ts";
import type { Book, RefKbMode } from "../shared/schemas/project.ts";
import { readJson, removePath, writeFileAtomic, writeJson } from "../store/json.ts";
import { safeFileName, segmentsAt } from "./pairs.ts";
import { NotFoundError, UserError } from "./projects.ts";

export async function loadBookStructure(
  app: AppContext,
  pid: string,
  bookId: string,
): Promise<EpubStructure> {
  const s = await readJson(app.paths.bookStructure(pid, bookId), EpubStructure);
  if (!s) throw new NotFoundError("Book structure");
  return s;
}

export function defaultSetup(structure: EpubStructure): BookSetup {
  const depth = Math.max(1, structure.maxDepth);
  const segments = segmentsAt(structure, depth);
  return {
    schemaVersion: 1,
    tocDepth: depth,
    phase2Segments: segments
      .filter((s) => s.linear && s.guess === "body" && s.words >= 100)
      .map((s) => s.id),
    keepDocs: [],
  };
}

export async function loadSetup(app: AppContext, pid: string, bookId: string): Promise<BookSetup> {
  const setup = await readJson(app.paths.bookSetup(pid, bookId), BookSetup);
  if (setup) return setup;
  return defaultSetup(await loadBookStructure(app, pid, bookId));
}

export async function importBook(
  app: AppContext,
  pid: string,
  file: { name: string; bytes: Uint8Array },
): Promise<Book> {
  await app.projects.get(pid);
  const epub = EpubBook.open(file.bytes);
  const structure = computeStructure(epub, "en");
  if (structure.totalWords === 0) throw new UserError("The book seems to have no text.");
  const pairs = await app.projects.pairs(pid);
  const book: Book = {
    schemaVersion: 1,
    id: newId("book"),
    title: epub.title,
    sourceFileName: safeFileName(file.name),
    pairIds: pairs.map((p) => p.id),
    refKbMode: "auto",
    options: { newIdentifier: true, removeEmbeddedFonts: false },
    createdAt: nowIso(),
    phase2: { state: "none", finishedAt: null, stepsDone: 0 },
    phase3: { state: "none", finishedAt: null },
    build: { builtAt: null, fileName: null },
  };
  await writeFileAtomic(app.paths.bookEpub(pid, book.id), file.bytes);
  await writeJson(app.paths.bookStructure(pid, book.id), EpubStructure, structure);
  await writeJson(app.paths.bookSetup(pid, book.id), BookSetup, defaultSetup(structure));
  await app.projects.saveBook(pid, book);
  await app.projects.touch(pid);
  return book;
}

export async function updateBook(
  app: AppContext,
  pid: string,
  bookId: string,
  patch: {
    pairIds?: string[];
    refKbMode?: RefKbMode;
    options?: Partial<Book["options"]>;
    title?: string;
  },
): Promise<Book> {
  const book = await app.projects.book(pid, bookId);
  if (patch.pairIds) {
    const known = new Set((await app.projects.pairs(pid)).map((p) => p.id));
    for (const id of patch.pairIds)
      if (!known.has(id)) throw new UserError("Unknown reference pair.");
  }
  return app.projects.saveBook(pid, {
    ...book,
    title: patch.title?.trim() || book.title,
    pairIds: patch.pairIds ?? book.pairIds,
    refKbMode: patch.refKbMode ?? book.refKbMode,
    options: { ...book.options, ...patch.options },
  });
}

export async function saveSetup(
  app: AppContext,
  pid: string,
  bookId: string,
  setup: BookSetup,
): Promise<BookSetup> {
  const structure = await loadBookStructure(app, pid, bookId);
  const segments = new Set(segmentsAt(structure, setup.tocDepth).map((s) => s.id));
  for (const id of setup.phase2Segments)
    if (!segments.has(id)) throw new UserError(`Unknown chapter ${id} for this TOC level.`);
  for (const d of setup.keepDocs) if (!structure.docs[d]) throw new UserError(`Unknown file ${d}.`);
  return writeJson(app.paths.bookSetup(pid, bookId), BookSetup, setup);
}

/** Reference KBs of the book's chosen pairs, in the book's order. */
export async function referenceKbs(
  app: AppContext,
  pid: string,
  book: Book,
): Promise<{ title: string; kb: Kb }[]> {
  const out: { title: string; kb: Kb }[] = [];
  for (const pairId of book.pairIds) {
    const kb = await readJson(app.paths.pairKb(pid, pairId), Kb).catch(() => undefined);
    if (!kb) continue;
    const pair = await app.projects.pair(pid, pairId).catch(() => undefined);
    out.push({ title: pair?.title ?? kb.title, kb });
  }
  return out;
}

/** All text of the book (for picking relevant reference entries). */
export async function bookPlainText(app: AppContext, pid: string, bookId: string): Promise<string> {
  const epub = await app.books.open(app.paths.bookEpub(pid, bookId));
  const parts: string[] = [];
  for (const doc of epub.docs) for (const u of epub.doc(doc.index).flow.units) parts.push(u.text);
  return parts.join("\n");
}

/** The smallest context window among the models of phases 2 and 3 (for reference KB selection). */
export function smallestContext(app: AppContext): number {
  const windows: number[] = [];
  for (const step of ["phase2.chapter", "phase2.review", "phase3.translate"] as const) {
    try {
      windows.push(app.settings.target(step).model.contextWindow);
    } catch {
      // step not configured yet
    }
  }
  return windows.length > 0 ? Math.min(...windows) : 128_000;
}

export async function referenceSelection(app: AppContext, pid: string, book: Book) {
  const refs = await referenceKbs(app, pid, book);
  return selectReferenceKbs(
    refs,
    await bookPlainText(app, pid, book.id),
    book.refKbMode,
    smallestContext(app),
  );
}

export async function bookDetail(app: AppContext, pid: string, bookId: string) {
  const book = await app.projects.book(pid, bookId);
  const structure = await loadBookStructure(app, pid, bookId);
  const setup = await loadSetup(app, pid, bookId);
  const pairs = await app.projects.pairs(pid);
  const selection = await referenceSelection(app, pid, book);
  return {
    book,
    structure,
    setup,
    pairs,
    reference: {
      mode: selection.mode,
      tokens: selection.tokens,
      entries: selection.entries,
      totalEntries: selection.totalEntries,
    },
  };
}

export async function deleteBook(app: AppContext, pid: string, bookId: string): Promise<void> {
  await app.projects.book(pid, bookId);
  app.books.forget(app.paths.bookEpub(pid, bookId));
  await removePath(app.paths.book(pid, bookId));
}
