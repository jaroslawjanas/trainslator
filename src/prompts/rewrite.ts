import { z } from "zod";
import type { PromptBlock } from "../llm/request.ts";
import { bookKbBlock, languageNotesBlock, referenceKbBlock } from "./common.ts";

/** Rewriting one passage of a translation (or a marked part of it) during review. */

export const REWRITE_PROMPT_VERSION = 1;

export const RewriteOutput = z.object({ text: z.string() });
export type RewriteOutput = z.infer<typeof RewriteOutput>;

/** Mark the part of the translation to rewrite. */
export const FRAGMENT_START = "⟦";
export const FRAGMENT_END = "⟧";

export interface RewritePromptInput {
  sourceName: string;
  targetName: string;
  targetTag: string;
  languageNotes: string;
  /** Null when the knowledge bases are left out. */
  referenceKb: string | null;
  bookKb: string | null;
  /** The passages before and after it, or null without context. */
  around: {
    before: { source: string; translation: string }[];
    after: { source: string; translation: string }[];
  } | null;
  /** The original passage, with placeholders. */
  source: string;
  /** Its translation, with the part to rewrite marked when only a part is rewritten. */
  translation: string;
  fragment: boolean;
  instruction: string | null;
}

function system(input: RewritePromptInput): string {
  const what = input.fragment
    ? `only the part of the translation marked ${FRAGMENT_START} … ${FRAGMENT_END}`
    : "the translation of the passage";
  return `You are an experienced literary translator revising a ${input.targetName} (${input.targetTag}) translation of a ${input.sourceName} book, one passage at a time.

You get the original passage and its current translation. Rewrite ${what} so that it reads naturally in ${input.targetName} and stays faithful to the original${input.instruction ? ", following the reviewer's instruction" : ""}.

Rules:
1. Placeholders mark formatting: <gN>…</gN> wraps formatted text (italics, links …), <xN/> stands for something kept as is (a line break, an image, a note reference). Keep every placeholder of the part you rewrite exactly once, around the matching words. Never invent placeholders or change their numbers.
2. Plain text only: no Markdown, no HTML, no quotation marks around the whole text, no comments or explanations.
3. ${input.fragment ? "Return only the new text for the marked part, without the markers, so that it fits back into the sentence around it." : "Return the whole passage."}
4. When knowledge bases are given, use their names, terms and style rules.

Return {"text": "…"}.${languageNotesBlock(input.targetName, input.languageNotes)}`;
}

function pairs(list: { source: string; translation: string }[]): string {
  return list.map((p) => `Original: ${p.source}\nTranslation: ${p.translation}`).join("\n\n");
}

export function rewriteBlocks(input: RewritePromptInput): PromptBlock[] {
  const blocks: PromptBlock[] = [
    {
      role: "system",
      label: "instructions",
      text: system(input),
      cacheBreakpoint: !input.referenceKb && !input.bookKb,
    },
  ];
  if (input.referenceKb)
    blocks.push({
      role: "user",
      label: "reference KBs",
      text: referenceKbBlock(input.referenceKb),
      cacheBreakpoint: true,
    });
  if (input.bookKb)
    blocks.push({
      role: "user",
      label: "book KB",
      text: bookKbBlock(input.bookKb),
      cacheBreakpoint: true,
    });
  if (input.around && (input.around.before.length > 0 || input.around.after.length > 0)) {
    const parts = [
      input.around.before.length > 0 ? `Before it:\n${pairs(input.around.before)}` : null,
      input.around.after.length > 0 ? `After it:\n${pairs(input.around.after)}` : null,
    ].filter(Boolean);
    blocks.push({
      role: "user",
      label: "around",
      text: `# The text around the passage (for context only; don't rewrite it)\n${parts.join("\n\n")}`,
    });
  }
  blocks.push({
    role: "user",
    label: "passage",
    text: `# The passage\nOriginal: ${input.source}\nTranslation: ${input.translation}${input.instruction ? `\n\nReviewer's instruction: ${input.instruction}` : ""}`,
  });
  return blocks;
}
