import { countWords, languageDisplayName, primarySubtag } from "../shared/languages.ts";
import type { Diagnostic } from "../shared/schemas/common.ts";
import type { EpubStructure } from "../shared/schemas/epub.ts";
import type { EpubBook } from "./book.ts";
import { buildSegments } from "./segments.ts";

/** Everything the UI shows about a book's structure, computed once at import. */
export function computeStructure(book: EpubBook, lang: string): EpubStructure {
  const segments = buildSegments(book, lang);
  const docs = book.docs.map((doc) => {
    const units = book.doc(doc.index).flow.units;
    const text = units
      .filter((u) => u.role !== "title" && u.kind !== "break")
      .map((u) => u.text)
      .join("\n");
    return {
      index: doc.index,
      href: doc.path,
      mediaType: doc.mediaType,
      inSpine: doc.inSpine,
      linear: doc.linear,
      units: units.filter((u) => u.kind !== "break").length,
      unsafeUnits: units.filter((u) => u.kind !== "break" && !u.safe).length,
      words: countWords(text, lang),
      isNav: doc.isNav,
    };
  });
  return {
    schemaVersion: 1,
    version: book.pkg.version,
    title: book.title,
    language: book.pkg.languages[0] ?? null,
    identifier: book.pkg.identifier,
    fixedLayout: book.pkg.fixedLayout,
    docs,
    toc: book.toc.map((t) => ({
      title: t.title,
      depth: t.depth,
      href: t.path ? `${t.path}${t.fragment ? `#${t.fragment}` : ""}` : null,
    })),
    maxDepth: segments.maxDepth,
    segmentsByDepth: segments.segmentsByDepth,
    totalWords: docs.filter((d) => d.inSpine).reduce((s, d) => s + d.words, 0),
    diagnostics: [...book.diagnose(), ...segments.diagnostics, ...languageMismatch(book, lang)],
  };
}

/** The book says it's in another language than the one it's imported as. */
function languageMismatch(book: EpubBook, lang: string): Diagnostic[] {
  const declared = book.pkg.languages[0];
  if (!declared || primarySubtag(declared) === primarySubtag(lang)) return [];
  return [
    {
      level: "warning",
      code: "language-mismatch",
      message: `The book's details say it's in ${languageDisplayName(declared)}, but it's used here as ${languageDisplayName(lang)}. Check that you chose the right file.`,
      docIndex: null,
      count: 1,
    },
  ];
}
