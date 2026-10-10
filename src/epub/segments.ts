import { countWords } from "../shared/languages.ts";
import type { Diagnostic } from "../shared/schemas/common.ts";
import type { Segment, SegmentGuess, UnitRange } from "../shared/schemas/epub.ts";
import type { EpubBook } from "./book.ts";
import type { FlowUnit } from "./flow.ts";
import type { TocEntry } from "./toc.ts";

interface StartPoint {
  title: string;
  depth: number;
  docIndex: number;
  unitIndex: number;
  /** Sort key: spine position (or doc index for docs outside the spine). */
  order: number;
  tocOrder: number;
}

export interface SegmentsResult {
  maxDepth: number;
  segmentsByDepth: Record<string, Segment[]>;
  diagnostics: Diagnostic[];
}

const MAX_DEPTH = 4;
const FRONT_RE =
  /\b(contents|table of contents|copyright|title page|half[- ]title|dedication|epigraph|cover|praise for|about the publisher|imprint|colophon|frontispiece|series page)\b/i;
const BACK_RE =
  /\b(about the authors?|acknowledg\w*|also by|end ?notes|notes|glossary|index|bibliography|credits|newsletter|sneak peek|excerpt|reading group|discussion questions|about the type|licen[cs]e)\b/i;

/** Builds logical chapters (segments) for each TOC depth. */
export function buildSegments(book: EpubBook, lang: string): SegmentsResult {
  const diagnostics: Diagnostic[] = [];
  const toc = book.toc;
  const tocMax = toc.reduce((m, e) => Math.max(m, e.depth), 0);
  const maxDepth = Math.max(1, Math.min(MAX_DEPTH, tocMax));
  const resolved = resolveStartPoints(book, toc, diagnostics);
  const segmentsByDepth: Record<string, Segment[]> = {};
  for (let depth = 1; depth <= maxDepth; depth++) {
    const points = resolved.filter((p) => p.depth <= depth);
    segmentsByDepth[String(depth)] = segmentsFor(book, points, depth, lang);
  }
  return { maxDepth, segmentsByDepth, diagnostics: dedupe(diagnostics) };
}

function dedupe(list: Diagnostic[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of list) {
    const existing = out.find((o) => o.code === d.code && o.docIndex === d.docIndex);
    if (existing) existing.count += d.count;
    else out.push({ ...d });
  }
  return out;
}

function resolveStartPoints(
  book: EpubBook,
  toc: TocEntry[],
  diagnostics: Diagnostic[],
): StartPoint[] {
  const points: StartPoint[] = [];
  toc.forEach((entry, i) => {
    let target: TocEntry | undefined = entry;
    if (!entry.path) {
      // Unlinked heading: starts where its first linked descendant starts.
      target = undefined;
      for (let j = i + 1; j < toc.length && toc[j]!.depth > entry.depth; j++) {
        if (toc[j]!.path) {
          target = toc[j];
          break;
        }
      }
      if (!target) return;
    }
    const doc = book.docByPath(target.path!);
    if (!doc?.inSpine) {
      diagnostics.push({
        level: "warning",
        code: "toc-target-missing",
        message: `A table-of-contents entry points to a file that isn't in the reading order (${target.path}).`,
        docIndex: null,
        count: 1,
      });
      return;
    }
    let unitIndex = 0;
    const flow = book.doc(doc.index).flow;
    if (target.fragment) {
      const found = flow.idToUnit.get(target.fragment);
      if (found === undefined) {
        diagnostics.push({
          level: "warning",
          code: "toc-anchor-missing",
          message: `A table-of-contents entry points to a missing anchor (#${target.fragment}); using the start of the file.`,
          docIndex: doc.index,
          count: 1,
        });
      } else {
        unitIndex = found;
      }
    }
    // The document <title> belongs with the chapter that starts after it.
    while (unitIndex > 0 && flow.units[unitIndex - 1]?.role === "title") unitIndex--;
    points.push({
      title: entry.title || target.title || "Untitled",
      depth: entry.depth,
      docIndex: doc.index,
      unitIndex,
      order: doc.spinePos ?? 1e6 + doc.index,
      tocOrder: i,
    });
  });
  return points;
}

function segmentsFor(
  book: EpubBook,
  rawPoints: StartPoint[],
  depth: number,
  lang: string,
): Segment[] {
  // Sort by position in the book; entries on the same unit merge (the first, outer one wins).
  const sorted = [...rawPoints].sort(
    (a, b) => a.order - b.order || a.unitIndex - b.unitIndex || a.tocOrder - b.tocOrder,
  );
  const points: StartPoint[] = [];
  for (const p of sorted) {
    const prev = points[points.length - 1];
    if (prev && prev.docIndex === p.docIndex && prev.unitIndex === p.unitIndex) continue;
    points.push(p);
  }

  const spineDocs = book.docs.filter((d) => d.inSpine);
  if (points.length < 2) return perDocumentSegments(book, spineDocs, depth, lang);

  interface Draft {
    title: string;
    depth: number;
    linear: boolean;
    ranges: UnitRange[];
  }
  const drafts: Draft[] = [];
  let currentLinear: Draft | null = null;
  const pointsByDoc = new Map<number, StartPoint[]>();
  for (const p of points) {
    const list = pointsByDoc.get(p.docIndex) ?? [];
    list.push(p);
    pointsByDoc.set(p.docIndex, list);
  }

  for (const doc of spineDocs) {
    const units = book.doc(doc.index).flow.units;
    const docPoints = pointsByDoc.get(doc.index) ?? [];
    if (!doc.linear) {
      // Non-linear documents never extend the surrounding chapter.
      let cursor = 0;
      let title =
        docPoints[0]?.unitIndex === 0 ? docPoints[0].title : `${shortName(doc.path)} (extra)`;
      let segDepth = docPoints[0]?.unitIndex === 0 ? docPoints[0].depth : depth;
      const starts = docPoints.filter((p) => p.unitIndex > 0);
      for (const p of starts) {
        if (p.unitIndex > cursor) {
          drafts.push({
            title,
            depth: segDepth,
            linear: false,
            ranges: [{ docIndex: doc.index, fromUnit: cursor, toUnit: p.unitIndex }],
          });
        }
        cursor = p.unitIndex;
        title = p.title;
        segDepth = p.depth;
      }
      if (units.length > cursor) {
        drafts.push({
          title,
          depth: segDepth,
          linear: false,
          ranges: [{ docIndex: doc.index, fromUnit: cursor, toUnit: units.length }],
        });
      }
      continue;
    }
    let cursor = 0;
    for (const p of docPoints) {
      if (p.unitIndex > cursor) {
        if (!currentLinear) {
          currentLinear = { title: "Front matter", depth: 0, linear: true, ranges: [] };
          drafts.push(currentLinear);
        }
        currentLinear.ranges.push({ docIndex: doc.index, fromUnit: cursor, toUnit: p.unitIndex });
      }
      currentLinear = { title: p.title, depth: p.depth, linear: true, ranges: [] };
      drafts.push(currentLinear);
      cursor = p.unitIndex;
    }
    if (units.length > cursor) {
      if (!currentLinear) {
        currentLinear = { title: "Front matter", depth: 0, linear: true, ranges: [] };
        drafts.push(currentLinear);
      }
      currentLinear.ranges.push({ docIndex: doc.index, fromUnit: cursor, toUnit: units.length });
    }
  }

  const segments = drafts
    .map((d) => finishSegment(book, d.title, d.depth, d.linear, d.ranges, lang))
    .filter((s) => s.ranges.length > 0 && (s.words > 0 || s.depth > 0));
  return assignIdsAndGuesses(segments, depth);
}

function perDocumentSegments(
  book: EpubBook,
  spineDocs: EpubBook["docs"],
  depth: number,
  lang: string,
): Segment[] {
  const segments = spineDocs.map((doc) => {
    const units = book.doc(doc.index).flow.units;
    const heading = units.find((u) => u.role === "heading");
    return finishSegment(
      book,
      heading?.text.slice(0, 80) || shortName(doc.path),
      1,
      doc.linear,
      [{ docIndex: doc.index, fromUnit: 0, toUnit: units.length }],
      lang,
    );
  });
  return assignIdsAndGuesses(
    segments.filter((s) => s.words > 0),
    depth,
  );
}

function shortName(p: string): string {
  return p.split("/").pop() ?? p;
}

export function segmentUnits(
  book: EpubBook,
  ranges: UnitRange[],
): { docIndex: number; unit: FlowUnit }[] {
  const out: { docIndex: number; unit: FlowUnit }[] = [];
  for (const r of ranges) {
    const units = book.doc(r.docIndex).flow.units;
    for (let i = r.fromUnit; i < r.toUnit && i < units.length; i++)
      out.push({ docIndex: r.docIndex, unit: units[i]! });
  }
  return out;
}

function finishSegment(
  book: EpubBook,
  title: string,
  depth: number,
  linear: boolean,
  ranges: UnitRange[],
  lang: string,
): Segment {
  const units = segmentUnits(book, ranges)
    .map((x) => x.unit)
    .filter((u) => u.kind !== "break" && u.role !== "title");
  const text = units.map((u) => u.text).join("\n");
  const flat = text.replace(/\s+/g, " ").trim();
  return {
    id: "pending",
    index: 0,
    title,
    depth,
    linear,
    ranges,
    words: countWords(text, lang),
    preview: {
      start: flat.slice(0, 220),
      end: flat.length > 220 ? flat.slice(-220) : "",
    },
    guess: "body",
  };
}

function assignIdsAndGuesses(segments: Segment[], depth: number): Segment[] {
  const big = segments.map(
    (s) => s.words >= 1000 && !FRONT_RE.test(s.title) && !BACK_RE.test(s.title),
  );
  const firstBig = big.indexOf(true);
  const lastBig = big.lastIndexOf(true);
  return segments.map((s, i) => {
    let guess: SegmentGuess = "body";
    if (!s.linear) guess = "back";
    else if (firstBig >= 0 && i < firstBig && (FRONT_RE.test(s.title) || s.words < 300))
      guess = "front";
    else if (lastBig >= 0 && i > lastBig && (BACK_RE.test(s.title) || s.words < 300))
      guess = "back";
    else if (FRONT_RE.test(s.title) && i < segments.length / 2) guess = "front";
    else if (BACK_RE.test(s.title) && i >= segments.length / 2) guess = "back";
    return { ...s, id: `d${depth}s${i}`, index: i, guess };
  });
}
