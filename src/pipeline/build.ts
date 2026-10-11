import path from "node:path";
import type { EpubBook } from "../epub/book.ts";
import { tokenize } from "../epub/splice.ts";
import { type BuildReport, buildTranslatedEpub } from "../epub/write.ts";
import {
  DocUnits,
  ManualEdits,
  TocTranslations,
  type TransUnit,
} from "../shared/schemas/translation.ts";
import { readJson, writeFileAtomic, writeJsonAtomic } from "../store/json.ts";
import type { DataPaths } from "../store/paths.ts";
import { loadResults } from "./phase3.ts";
import { checkUnitTranslation, type LanguageChecks, languageChecks } from "./validate.ts";

export interface BuildOptions {
  /** Use the best attempt (made safe) for flagged units instead of stopping. */
  useBestAttempts: boolean;
  newIdentifier: boolean;
  removeEmbeddedFonts: boolean;
}

export interface BookBuildReport extends BuildReport {
  fileName: string;
  flaggedUsed: number;
  keptSource: number;
  builtAt: string;
}

export class BuildBlockedError extends Error {
  readonly flagged: number;
  constructor(flagged: number) {
    super(`${flagged} unit(s) are flagged. Fix them in review, or build with "use best attempts".`);
    this.name = "BuildBlockedError";
    this.flagged = flagged;
  }
}

/**
 * Makes a flagged translation safe to write: drops broken optional
 * placeholders, adds missing required <xN/> at the end, removes duplicates.
 * Returns null when it can't be made safe (the source text is kept instead).
 */
export function safeFallback(
  unit: TransUnit,
  text: string | null,
  languages?: LanguageChecks,
): string | null {
  if (text === null || !text.trim()) return null;
  const byN = new Map(unit.placeholders.map((p) => [p.n, p]));
  const seenX = new Set<number>();
  let out = "";
  const stack: number[] = [];
  for (const token of tokenize(text)) {
    if (token.t === "text") {
      out += token.text;
      continue;
    }
    const p = byN.get(token.n);
    if (!p) continue;
    if (token.t === "x") {
      if (p.kind === "x" && !seenX.has(p.n)) {
        seenX.add(p.n);
        out += `<x${p.n}/>`;
      }
    } else if (p.kind === "g" && p.required) {
      // Required pairs are kept only if well-formed overall; checked below.
      if (token.t === "open") {
        stack.push(p.n);
        out += `<g${p.n}>`;
      } else if (stack[stack.length - 1] === p.n) {
        stack.pop();
        out += `</g${p.n}>`;
      }
    }
    // Optional g placeholders are dropped (keeping their text).
  }
  for (const p of unit.placeholders) {
    if (p.kind === "x" && !seenX.has(p.n)) out += `<x${p.n}/>`;
  }
  const check = checkUnitTranslation(unit, out, { targetScripts: [], ratio: 1, languages });
  return check.errors.length === 0 ? out : null;
}

function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "book"
  );
}

export async function buildBook(args: {
  paths: DataPaths;
  projectId: string;
  bookId: string;
  book: EpubBook;
  sourceLang: string;
  targetLang: string;
  direction: "ltr" | "rtl";
  keepDocs: Set<number>;
  baseName: string;
  options: BuildOptions;
}): Promise<{ file: string; report: BookBuildReport }> {
  const { paths, projectId, bookId, book } = args;
  const unitsByDoc = new Map<number, TransUnit[]>();
  for (const doc of book.docs) {
    if (args.keepDocs.has(doc.index)) continue;
    const file = await readJson(paths.phase3Units(projectId, bookId, doc.index), DocUnits);
    if (file) unitsByDoc.set(doc.index, file.units);
  }
  const tocFile = await readJson(paths.phase3Units(projectId, bookId, 9999), DocUnits);
  const tocUnits = tocFile?.units ?? [];
  const results = await loadResults(paths, projectId, bookId);
  const edits = (await readJson(paths.phase3Edits(projectId, bookId), ManualEdits))?.edits ?? {};
  const toc = await readJson(paths.phase3Toc(projectId, bookId), TocTranslations);

  const allUnits = new Map<string, TransUnit>();
  for (const list of unitsByDoc.values()) for (const u of list) allUnits.set(u.key, u);
  for (const u of tocUnits) allUnits.set(u.key, u);

  const translations = new Map<string, string>();
  let flagged = 0;
  let flaggedUsed = 0;
  let keptSource = 0;
  const languages = languageChecks(args.sourceLang, args.targetLang);
  for (const r of results.values()) {
    for (const u of r.units) {
      const unit = allUnits.get(u.key);
      if (!unit) continue;
      if (edits[u.key]) continue;
      if (u.status === "ok" && u.text !== null) {
        translations.set(u.key, u.text);
      } else {
        flagged++;
        if (args.options.useBestAttempts) {
          const safe = safeFallback(unit, u.text, languages);
          if (safe !== null) {
            translations.set(u.key, safe);
            flaggedUsed++;
          } else {
            keptSource++;
          }
        }
      }
    }
  }
  for (const [key, edit] of Object.entries(edits)) translations.set(key, edit.text);
  if (toc)
    for (const [key, text] of Object.entries(toc.items))
      if (!edits[key]) translations.set(key, text);
  if (flagged > 0 && !args.options.useBestAttempts) throw new BuildBlockedError(flagged);

  const { bytes, report } = buildTranslatedEpub({
    book,
    sourceLang: args.sourceLang,
    targetLang: args.targetLang,
    direction: args.direction,
    unitsByDoc,
    tocUnits,
    translations,
    keepDocs: args.keepDocs,
    title: edits.title?.text ?? toc?.title ?? null,
    newIdentifier: args.options.newIdentifier,
    removeEmbeddedFonts: args.options.removeEmbeddedFonts,
  });
  const fileName = `${slug(args.baseName)}.${args.targetLang}.epub`;
  const file = path.join(paths.outputDir(projectId, bookId), fileName);
  await writeFileAtomic(file, bytes);
  const full: BookBuildReport = {
    ...report,
    fileName,
    flaggedUsed,
    keptSource,
    builtAt: new Date().toISOString(),
  };
  await writeJsonAtomic(paths.buildReport(projectId, bookId), full);
  return { file, report: full };
}
