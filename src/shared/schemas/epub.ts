import { z } from "zod";
import { Diagnostic, Id, SchemaVersion } from "./common.ts";

export const DocInfo = z.object({
  index: z.number().int().nonnegative(),
  href: z.string(),
  mediaType: z.string(),
  inSpine: z.boolean(),
  linear: z.boolean(),
  units: z.number().int().nonnegative(),
  unsafeUnits: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  /** Part of the navigation document (nav.xhtml). */
  isNav: z.boolean(),
});
export type DocInfo = z.infer<typeof DocInfo>;

export const UnitRange = z.object({
  docIndex: z.number().int().nonnegative(),
  /** Index of the first unit (inclusive). */
  fromUnit: z.number().int().nonnegative(),
  /** Index of the last unit (exclusive). */
  toUnit: z.number().int().nonnegative(),
});
export type UnitRange = z.infer<typeof UnitRange>;

export const SegmentGuess = z.enum(["front", "body", "back"]);
export type SegmentGuess = z.infer<typeof SegmentGuess>;

export const Segment = z.object({
  id: Id,
  index: z.number().int().nonnegative(),
  title: z.string(),
  depth: z.number().int().nonnegative(),
  linear: z.boolean(),
  ranges: z.array(UnitRange),
  words: z.number().int().nonnegative(),
  preview: z.object({ start: z.string(), end: z.string() }),
  guess: SegmentGuess,
});
export type Segment = z.infer<typeof Segment>;

export const TocItem = z.object({
  title: z.string(),
  depth: z.number().int().nonnegative(),
  href: z.string().nullable(),
});
export type TocItem = z.infer<typeof TocItem>;

export const EpubStructure = z.object({
  schemaVersion: SchemaVersion,
  version: z.string(),
  title: z.string(),
  language: z.string().nullable(),
  identifier: z.string().nullable(),
  fixedLayout: z.boolean(),
  docs: z.array(DocInfo),
  toc: z.array(TocItem),
  /** Maximum TOC depth (1 = top level only). */
  maxDepth: z.number().int().nonnegative(),
  /** Segments for each TOC depth, keyed by depth ("1", "2", …). */
  segmentsByDepth: z.record(z.string(), z.array(Segment)),
  totalWords: z.number().int().nonnegative(),
  diagnostics: z.array(Diagnostic),
});
export type EpubStructure = z.infer<typeof EpubStructure>;

/** A book's own choices about which segments and files are used. */
export const BookSetup = z.object({
  schemaVersion: SchemaVersion,
  tocDepth: z.number().int().positive(),
  /** Segment ids (for `tocDepth`) included in phase 2. */
  phase2Segments: z.array(Id),
  /** Doc indices kept in the original language in phase 3. */
  keepDocs: z.array(z.number().int().nonnegative()),
});
export type BookSetup = z.infer<typeof BookSetup>;
