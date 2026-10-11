import { z } from "zod";
import type { PromptBlock } from "../llm/request.ts";
import { KbKind } from "../shared/schemas/kb.ts";
import { bookKbBlock, jsonLines, languageNotesBlock, referenceKbBlock } from "./common.ts";

export const PHASE3_PROMPT_VERSION = 1;

export const Phase3Output = z.object({
  units: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    }),
  ),
  coined: z.array(
    z.object({
      kind: KbKind,
      source: z.string(),
      target: z.string(),
      note: z.string(),
    }),
  ),
});
export type Phase3Output = z.infer<typeof Phase3Output>;

export interface Phase3Unit {
  id: string;
  text: string;
  /** Placeholders that must appear exactly once. */
  keep: string[];
}

export interface Phase3PromptInput {
  sourceName: string;
  /** Inflected source languages: coined terms in their base form. Off (absent) for English. */
  baseForms?: boolean;
  targetName: string;
  targetTag: string;
  languageNotes: string;
  referenceKb: string | null;
  bookKb: string | null;
  glossary: { source: string; target: string; note: string }[];
  synopsis: string | null;
  /** Whole chapters: phase 2's summaries of the chapters before this one, oldest first. */
  storySoFar?: string[];
  /** Whole chapters sent in parts: the chapter's text around this part, with the part marked. */
  chapterText?: string | null;
  /** Whole chapters sent in parts: the translation of the chapter up to this part. */
  translatedSoFar?: string[];
  /** Chunks: the last paragraphs before this chunk, with their translations. */
  previous: { source: string; translation: string }[];
  units: Phase3Unit[];
  /** Extra instruction for re-translations ("more formal"). */
  instruction: string | null;
}

export function phase3System(
  sourceName: string,
  targetName: string,
  targetTag: string,
  languageNotes: string,
  /** Inflected source languages: coined terms in their base form. Off for English. */
  baseForms = false,
): string {
  const coinedForm = baseForms
    ? ` Give "source" in its ${sourceName} base form (nominative singular, without an article).`
    : "";
  return `You are an experienced literary translator. Translate ${sourceName} text into ${targetName} (${targetTag}).

The input is a JSON array of units from a book, in reading order. Each unit is a paragraph, heading, caption, list item or similar, given as {"id", "text"}.

Rules:
1. Return exactly one output unit for every input unit, with the same id, in the same order. Never merge, split, skip or add units.
2. Placeholders in the text mark formatting:
   - <gN>…</gN> wraps formatted text (italics, links, small caps …). Keep the pair around the words that correspond in your translation. You may move it to follow natural word order.
   - <xN/> stands for something kept as-is (a line break, an image, a note reference). Keep it in the matching position.
   - Placeholders listed in a unit's "keep" must appear exactly once. Other placeholders may be dropped only when ${targetName} has no equivalent (for example an ordinal suffix), never just for convenience.
   - Never invent placeholders, never change their numbers, and keep them properly nested.
3. Output plain text only: no Markdown, no HTML tags, no quotation marks around a whole unit, no comments or explanations.
4. Translate everything, including headings, titles and captions. Keep numbers, URLs, and passages meant to stay in another language as they are.
5. Follow the knowledge bases: use the listed names, terms and style rules consistently.
6. Preserve the author's tone, register, rhythm and paragraphing. Don't summarize, soften or add anything.
7. If you invent a translation for a name or recurring term that isn't in the knowledge bases, list it in "coined" (kind, source, your translation, a short note).${coinedForm} Otherwise return an empty "coined" array.${languageNotesBlock(targetName, languageNotes)}`;
}

/** Prompt blocks for one chunk, ordered from most to least stable for caching. */
export function phase3Blocks(input: Phase3PromptInput): PromptBlock[] {
  const blocks: PromptBlock[] = [
    {
      role: "system",
      label: "instructions",
      text: phase3System(
        input.sourceName,
        input.targetName,
        input.targetTag,
        input.languageNotes,
        input.baseForms,
      ),
      cacheBreakpoint: !input.referenceKb && !input.bookKb,
    },
  ];
  if (input.referenceKb) {
    blocks.push({
      role: "user",
      label: "reference KBs",
      text: referenceKbBlock(input.referenceKb),
      cacheBreakpoint: true,
    });
  }
  if (input.bookKb) {
    blocks.push({
      role: "user",
      label: "book KB",
      text: bookKbBlock(input.bookKb),
      cacheBreakpoint: true,
    });
  }
  if (input.storySoFar && input.storySoFar.length > 0) {
    blocks.push({
      role: "user",
      label: "story so far",
      text: `# The story so far\nSummaries of the chapters before this one, for context.\n${input.storySoFar.map((s) => `- ${s}`).join("\n")}`,
    });
  }
  if (input.chapterText) {
    blocks.push({
      role: "user",
      label: "chapter",
      text: `# This chapter\nIt is translated in parts. Here is its text around the part to translate now, for context only: translate just the units listed at the end.\n\n${input.chapterText}`,
      cacheBreakpoint: true,
    });
  }
  if (input.glossary.length > 0) {
    blocks.push({
      role: "user",
      label: "glossary",
      text: `# Terms introduced earlier in this translation\nUse them consistently.\n${input.glossary.map((g) => `- ${g.source} → ${g.target}${g.note ? ` (${g.note})` : ""}`).join("\n")}`,
    });
  }
  if (input.synopsis) {
    blocks.push({
      role: "user",
      label: "synopsis",
      text: `# What happens in this chapter\n${input.synopsis}`,
    });
  }
  if (input.translatedSoFar && input.translatedSoFar.length > 0) {
    blocks.push({
      role: "user",
      label: "translation so far",
      text: `# Your translation of this chapter so far\nContinue from here in the same voice and with the same word choices. Don't translate it again.\n\n${input.translatedSoFar.join("\n\n")}`,
    });
  }
  if (input.previous.length > 0) {
    blocks.push({
      role: "user",
      label: "previous text",
      text: `# Text just before this part (already translated; for context only, don't translate it again)\n${input.previous
        .map((p) => `Source: ${p.source}\nTranslation: ${p.translation}`)
        .join("\n\n")}`,
    });
  }
  const instruction = input.instruction
    ? `\nAdditional instruction for this part: ${input.instruction}\n`
    : "";
  blocks.push({
    role: "user",
    label: "units",
    text: `# Units to translate into ${input.targetName}${input.chapterText ? " (the part marked in the chapter above)" : ""}${instruction}\n${jsonLines(
      input.units.map((u) =>
        u.keep.length > 0 ? { id: u.id, text: u.text, keep: u.keep } : { id: u.id, text: u.text },
      ),
    )}`,
  });
  return blocks;
}

export const TocOutput = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })),
});
export type TocOutput = z.infer<typeof TocOutput>;

export function tocBlocks(input: {
  sourceName: string;
  baseForms?: boolean;
  targetName: string;
  targetTag: string;
  languageNotes: string;
  bookKb: string | null;
  headings: { source: string; translation: string }[];
  items: Phase3Unit[];
}): PromptBlock[] {
  const blocks: PromptBlock[] = [
    {
      role: "system",
      label: "instructions",
      text: `${phase3System(input.sourceName, input.targetName, input.targetTag, input.languageNotes, input.baseForms)}

You are now translating the book's title and the labels of its table of contents and navigation. Keep labels consistent with the chapter headings already translated (listed below). Return {"items": [{"id", "text"}]} with one item per input unit.`,
    },
  ];
  if (input.bookKb)
    blocks.push({ role: "user", label: "book KB", text: bookKbBlock(input.bookKb) });
  if (input.headings.length > 0) {
    blocks.push({
      role: "user",
      label: "headings",
      text: `# Chapter headings as translated\n${input.headings.map((h) => `${h.source} → ${h.translation}`).join("\n")}`,
    });
  }
  blocks.push({
    role: "user",
    label: "units",
    text: `# Labels to translate\n${jsonLines(input.items.map((u) => (u.keep.length ? { id: u.id, text: u.text, keep: u.keep } : { id: u.id, text: u.text })))}`,
  });
  return blocks;
}
