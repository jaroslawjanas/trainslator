import { z } from "zod";
import type { SourceLanguage } from "../languages/index.ts";
import type { PromptBlock } from "../llm/request.ts";
import { KbKind, KbTreatment, KeyValue } from "../shared/schemas/kb.ts";
import { baseFormRule, isEnglish, languageNotesBlock } from "./common.ts";

export const PHASE1_PROMPT_VERSION = 2;

// ---------------------------------------------------------------------------
// Reading one chapter pair
// ---------------------------------------------------------------------------

export const Finding = z.object({
  kind: KbKind,
  source: z.string().describe("the name or term as written in English"),
  target: z
    .string()
    .nullable()
    .describe("the translator's rendering in its dictionary form (nominative, base form)"),
  targetSeen: z
    .array(z.string())
    .describe("other forms of the rendering seen in this chapter (inflections, variants)"),
  treatment: KbTreatment.nullable(),
  attributes: z
    .array(KeyValue)
    .describe("facts that matter for the translation, e.g. gender, address"),
  note: z.string().describe("why it matters / what the translator did, in English"),
  sourceQuote: z.string().describe("a short English quote, at most 25 words"),
  targetQuote: z.string().nullable().describe("the matching translated quote, at most 25 words"),
});
export type Finding = z.infer<typeof Finding>;

export const StyleNote = z.object({
  rule: z.string().describe("a general convention of this translator, in English"),
  sourceQuote: z.string(),
  targetQuote: z.string(),
});
export type StyleNote = z.infer<typeof StyleNote>;

export const ReadOutput = z.object({
  findings: z.array(Finding),
  styleNotes: z.array(StyleNote),
});
export type ReadOutput = z.infer<typeof ReadOutput>;

const readOutputs = new Map<string, typeof ReadOutput>();

/** The read schema for a source language: English uses ReadOutput itself (same bytes, same cache). */
export function readOutputFor(source: SourceLanguage): typeof ReadOutput {
  if (isEnglish(source)) return ReadOutput;
  let schema = readOutputs.get(source.name);
  if (!schema) {
    schema = z.object({
      findings: z.array(
        Finding.extend({
          source: z
            .string()
            .describe(
              `the name or term as written in ${source.name}, in its base form (nominative singular, without an article)`,
            ),
          sourceQuote: z.string().describe(`a short ${source.name} quote, at most 25 words`),
        }),
      ),
      styleNotes: z.array(StyleNote),
    });
    readOutputs.set(source.name, schema);
  }
  return schema;
}

export function readSystem(
  source: SourceLanguage,
  targetName: string,
  languageNotes: string,
): string {
  return `You study how a professional translator rendered ${source.article} ${source.name} novel into ${targetName}, so that a new translator can stay consistent with their choices.

You get one chapter in ${source.name} and the same chapter in the published ${targetName} translation. The two may not start or end at exactly the same sentence.

Record decisions a new translator must repeat:
- names of people, places, organizations, ships, books and other named things: whether they were kept, translated, transliterated or adapted, and the exact rendering;
- invented words and recurring terms or phrases specific to this book or its world;
- wordplay, jokes, songs and verses: what the translator did instead;
- forms of address between characters (formal or informal), titles and honorifics;
- facts that affect grammar in ${targetName}, such as a character's gender, recorded as attributes.

Give the rendering in its dictionary form (nominative, base form) as "target", and list other forms you saw in "targetSeen".
${isEnglish(source) ? "" : `${baseFormRule(source)}\n`}Skip ordinary words and phrases that any dictionary would translate the same way. Quotes must be short (at most 25 words), and notes one or two sentences.
Record each name or term once per chapter, with the most important ones first.
Also note general conventions of this translator in "styleNotes" (dialogue punctuation, units, how footnotes or foreign words are handled, swearing, register).
Write notes in English.${languageNotesBlock(targetName, languageNotes)}`;
}

export function readBlocks(input: {
  source: SourceLanguage;
  targetName: string;
  languageNotes: string;
  sourceText: string;
  targetText: string;
  part: { index: number; count: number } | null;
}): PromptBlock[] {
  const partNote = input.part
    ? `\nThis is part ${input.part.index + 1} of ${input.part.count} of a long chapter; the translated excerpt may start a little earlier or end a little later than the ${input.source.name} one.`
    : "";
  return [
    {
      role: "system",
      label: "instructions",
      text: readSystem(input.source, input.targetName, input.languageNotes),
      cacheBreakpoint: true,
    },
    {
      role: "user",
      label: "chapter pair",
      text: `# ${input.source.name} chapter${partNote}\n\n${input.sourceText}\n\n# ${input.targetName} translation\n\n${input.targetText}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Merging findings into entries
// ---------------------------------------------------------------------------

export const EntryDraft = z.object({
  kind: KbKind,
  source: z.string(),
  aliases: z.array(z.string()),
  target: z.string().nullable(),
  treatment: KbTreatment.nullable(),
  attributes: z.array(KeyValue),
  note: z.string(),
});
export type EntryDraft = z.infer<typeof EntryDraft>;

export const MergeDecision = z.object({
  group: z.string(),
  action: z.enum(["entry", "merge_into", "drop"]),
  into: z
    .string()
    .nullable()
    .describe("for merge_into: the group (gN) or existing entry (pN) it belongs to"),
  reason: z.string().nullable(),
  entry: EntryDraft.nullable().describe(
    'for "entry": the final entry, or null to build it from the group as listed',
  ),
});
export type MergeDecision = z.infer<typeof MergeDecision>;

export const MergeOutput = z.object({ decisions: z.array(MergeDecision) });
export type MergeOutput = z.infer<typeof MergeOutput>;

export function mergeSystem(
  source: SourceLanguage,
  targetName: string,
  languageNotes: string,
): string {
  return `You turn notes about a published ${source.name}→${targetName} translation into a clean knowledge base for future translators.

Each group below collects what was observed about one name or term across the book's chapters: the renderings seen (with how often), facts, notes and examples.

For every group in the batch, decide exactly once:
- "entry": it belongs in the knowledge base. Set "entry" to null to use the group as listed, or give the corrected entry (pick the dominant rendering as "target", merge facts, write one short note).
- "merge_into": it is the same thing as another group or existing entry (an alias, nickname, short form or different spelling). Set "into" to that gN or pN id from the index.
- "drop": not useful (an ordinary word, a one-off with nothing to learn, a misreading). Give a short reason.
When renderings conflict, prefer the most frequent one and mention the other in the note.${languageNotesBlock(targetName, languageNotes)}`;
}

export const StyleOutput = z.object({
  rules: z.array(
    z.object({
      rule: z.string(),
      sourceExample: z.string().nullable(),
      targetExample: z.string().nullable(),
    }),
  ),
});
export type StyleOutput = z.infer<typeof StyleOutput>;

export function styleBlocks(
  source: SourceLanguage,
  targetName: string,
  languageNotes: string,
  notes: string,
): PromptBlock[] {
  return [
    {
      role: "system",
      label: "instructions",
      text: `You summarize the conventions a professional translator followed when translating ${source.article} ${source.name} novel into ${targetName}. Merge the notes below into at most 30 clear, general rules a new translator should follow, most important first. Drop notes that are one-offs or contradict the majority. Add one short example to a rule when it helps.${languageNotesBlock(targetName, languageNotes)}`,
    },
    {
      role: "user",
      label: "style notes",
      text: `# Notes from the chapters (with how often each was seen)\n${notes}`,
    },
  ];
}
