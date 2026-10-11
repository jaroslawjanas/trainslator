/**
 * Identity round trip over real EPUBs: extract every unit, "translate" each
 * one to itself, rebuild the book, and check that every document is
 * canonically unchanged and has no new XML problems.
 *
 *   pnpm test:corpus [folder]     (default: data/corpus)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractDocUnits, type TransUnit } from "../src/epub/blocks.ts";
import { EpubBook } from "../src/epub/book.ts";
import { buildSegments } from "../src/epub/segments.ts";
import { buildTranslatedEpub, extractTocUnits } from "../src/epub/write.ts";
import { readZip } from "../src/epub/zip.ts";
import { defaultDataDir } from "../src/store/paths.ts";
import { canonical } from "../src/testing/canonical.ts";

const folder = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(defaultDataDir(), "corpus");

async function main(): Promise<void> {
  let files: string[];
  try {
    files = (await fs.readdir(folder)).filter((f) => f.toLowerCase().endsWith(".epub"));
  } catch {
    console.log(`No corpus folder at ${folder}. Put some DRM-free EPUBs there to run this check.`);
    return;
  }
  if (files.length === 0) {
    console.log(`No .epub files in ${folder}.`);
    return;
  }
  let failures = 0;
  for (const file of files) {
    const started = Date.now();
    const bytes = new Uint8Array(await fs.readFile(path.join(folder, file)));
    let book: EpubBook;
    try {
      book = EpubBook.open(bytes);
    } catch (error) {
      console.log(`SKIP ${file}: ${(error as Error).message}`);
      continue;
    }
    const unitsByDoc = new Map<number, TransUnit[]>();
    const translations = new Map<string, string>();
    let units = 0;
    let unsafe = 0;
    for (const doc of book.docs) {
      const list = extractDocUnits(book, doc.index);
      unitsByDoc.set(doc.index, list);
      for (const u of list) {
        if (u.translate) {
          translations.set(u.key, u.text);
          units++;
        } else if (u.skipReason && u.skipReason !== "no letters") {
          unsafe++;
        }
      }
    }
    const tocUnits = extractTocUnits(book);
    for (const u of tocUnits) if (u.translate) translations.set(u.key, u.text);
    // Front and back matter are guessed in the book's own language.
    const segments = buildSegments(book, book.pkg.languages[0] ?? "en");

    const problems: string[] = [];
    try {
      const { bytes: out, report } = buildTranslatedEpub({
        book,
        sourceLang: "en",
        targetLang: "en",
        direction: "ltr",
        unitsByDoc,
        tocUnits,
        translations,
        keepDocs: new Set(),
        title: null,
        newIdentifier: false,
        removeEmbeddedFonts: false,
      });
      const outEntries = new Map(readZip(out).map((e) => [e.name, e.data]));
      for (const doc of book.docs) {
        const after = new TextDecoder().decode(outEntries.get(doc.path));
        if (canonical(after) !== canonical(book.doc(doc.index).src))
          problems.push(`content changed: ${doc.path}`);
      }
      for (const p of report.newXmlProblems)
        problems.push(`new XML problems in ${p.file}: ${p.problems.join("; ")}`);
    } catch (error) {
      problems.push(`build failed: ${(error as Error).message}`);
    }

    const ms = Date.now() - started;
    const depth1 = segments.segmentsByDepth["1"]?.length ?? 0;
    const status = problems.length === 0 ? "OK  " : "FAIL";
    if (problems.length > 0) failures++;
    console.log(
      `${status} ${file}: ${book.docs.length} files, ${units} units, ${unsafe} unsafe, ${depth1} chapters (TOC: ${book.tocSource}), ${ms} ms`,
    );
    for (const p of problems.slice(0, 10)) console.log(`     - ${p}`);
  }
  if (failures > 0) process.exitCode = 1;
}

await main();
