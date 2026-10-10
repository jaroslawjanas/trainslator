import { z } from "zod";
import type { PromptBlock } from "../llm/request.ts";
import { KbTreatment, KeyValue } from "../shared/schemas/kb.ts";
import { bookKbBlock, languageNotesBlock, referenceKbBlock } from "./common.ts";

/** Asking a model to settle one open question in a knowledge base. */

export const KbAnswer = z.object({
  /** The translation to use (dictionary form), or null to leave it undecided. */
  target: z.string().nullable(),
  treatment: KbTreatment.nullable(),
  /** The facts the entry should have, all of them. */
  attributes: z.array(KeyValue),
  note: z.string(),
  /** Why, for the person deciding. */
  explanation: z.string(),
});
export type KbAnswer = z.infer<typeof KbAnswer>;

export interface KbQuestionInput {
  sourceName: string;
  targetName: string;
  languageNotes: string;
  referenceKb: string | null;
  /** The rest of the knowledge base the entry belongs to. */
  ownKb: string | null;
  /** What happens in the chapters where the entry appears (books). */
  synopses: string[];
  /** The entry, as JSON. */
  entry: string;
  question: string;
}

export function kbQuestionBlocks(input: KbQuestionInput): PromptBlock[] {
  const blocks: PromptBlock[] = [
    {
      role: "system",
      label: "instructions",
      text: `You help translate a book from ${input.sourceName} into ${input.targetName}. Its knowledge base records how names, terms and recurring phrases are translated, and one entry has an open question that the translator couldn't settle. Answer it.

Decide the translation (in its dictionary form), how it's treated (kept, translated, transliterated, adapted, omitted, other), the facts it needs (for example gender, number, formal or informal address), and a short note for translators. Stay consistent with the knowledge bases. If the question can't be settled from what you have, give your best answer and say what's uncertain in the explanation.

Return {"target", "treatment", "attributes" (all of the entry's facts, kept or changed), "note", "explanation" (a few sentences for the person deciding)}.${languageNotesBlock(input.targetName, input.languageNotes)}`,
      cacheBreakpoint: !input.referenceKb && !input.ownKb,
    },
  ];
  if (input.referenceKb)
    blocks.push({
      role: "user",
      label: "reference KBs",
      text: referenceKbBlock(input.referenceKb),
      cacheBreakpoint: !input.ownKb,
    });
  if (input.ownKb)
    blocks.push({
      role: "user",
      label: "knowledge base",
      text: bookKbBlock(input.ownKb),
      cacheBreakpoint: true,
    });
  if (input.synopses.length > 0)
    blocks.push({
      role: "user",
      label: "synopses",
      text: `# What happens in the chapters where it appears\n${input.synopses.map((s) => `- ${s}`).join("\n")}`,
    });
  blocks.push({
    role: "user",
    label: "question",
    text: `# The entry\n${input.entry}\n\n# The open question\n${input.question}`,
  });
  return blocks;
}
