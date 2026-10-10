import { z } from "zod";
import type { PromptBlock } from "../llm/request.ts";
import { KbKind, KbTreatment, KeyValue } from "../shared/schemas/kb.ts";
import { bookKbBlock, languageNotesBlock, referenceKbBlock } from "./common.ts";

export const PHASE2_PROMPT_VERSION = 2;

export const EditFields = z.object({
  kind: KbKind.nullable(),
  source: z.string().nullable(),
  aliases: z.array(z.string()).nullable().describe("added to the existing aliases"),
  target: z.string().nullable().describe("proposed translation, dictionary form"),
  treatment: KbTreatment.nullable(),
  attributes: z.array(KeyValue).nullable().describe("matched by key; e.g. gender, address"),
  note: z.string().nullable(),
  status: z.enum(["auto", "open"]).nullable().describe('"open" = undecided, needs a question'),
  question: z.string().nullable().describe("for open entries: what still needs deciding"),
});
export type EditFields = z.infer<typeof EditFields>;

export const Edit = z.object({
  op: z.enum(["add", "update", "resolve", "remove"]),
  id: z.string().nullable().describe("for update/resolve/remove: the entry's id, e.g. p12"),
  fields: EditFields.nullable().describe("for add/update/resolve: only what changes; null = keep"),
  reason: z.string(),
});
export type Edit = z.infer<typeof Edit>;

export const ChapterOutput = z.object({
  synopsis: z.string(),
  edits: z.array(Edit),
});
export type ChapterOutput = z.infer<typeof ChapterOutput>;

export const ReviewOutput = z.object({ edits: z.array(Edit) });
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export function phase2System(targetName: string, languageNotes: string): string {
  return `You prepare a knowledge base for translating an English novel into ${targetName}. You read the whole book chapter by chapter before any translating starts, so the translator knows names, terms and facts in advance.

For each chapter:
1. Write a synopsis in English (at most 120 words): who appears, what happens, and anything that matters for translation later (genders, relationships, who speaks formally to whom, double meanings).
2. Return edits to the knowledge base:
   - Check the open questions first. If this chapter answers one, "resolve" it (give the decided translation and facts).
   - "add" what a translator could otherwise get wrong or render inconsistently from chapter to chapter: names (people, places, organizations, ships, books, other named things), characters known by a description who appear more than once (with facts such as gender), titles and forms of address, invented or archaic terms, recurring phrases and wordplay. Propose a translation into ${targetName} in its dictionary form, consistent with the knowledge from earlier human translations: if they kept a name, keep it; if they translated a term, use their translation.
   - Don't add one-off mentions, ordinary objects, animals or professions, or anything a dictionary translates the same way in any context. A focused list of what matters is more useful than a long one.
   - When something can't be decided yet (for example a character's gender hasn't been revealed and ${targetName} needs it), add the entry with status "open" and a short question instead of guessing.
   - "update" entries that this chapter adds facts to or contradicts. Give only the fields that change; null keeps a field.
   - "remove" entries that turned out to be wrong, with a reason.
   Refer to existing entries by their id (p1, p2 …). Don't add what already exists, and don't add ordinary words. Entries marked [locked] were decided by the editor; don't change them.
   Every edit needs a reason of a few words. In "fields", keys you don't set may be left out.${languageNotesBlock(targetName, languageNotes)}`;
}

export function chapterBlocks(input: {
  targetName: string;
  languageNotes: string;
  referenceKb: string | null;
  synopses: { title: string; synopsis: string }[];
  bookKb: string;
  chapterTitle: string;
  chapterText: string;
  part: { index: number; count: number } | null;
}): PromptBlock[] {
  const blocks: PromptBlock[] = [
    {
      role: "system",
      label: "instructions",
      text: phase2System(input.targetName, input.languageNotes),
      cacheBreakpoint: !input.referenceKb,
    },
  ];
  if (input.referenceKb)
    blocks.push({
      role: "user",
      label: "reference KBs",
      text: referenceKbBlock(input.referenceKb),
      cacheBreakpoint: true,
    });
  if (input.synopses.length > 0) {
    blocks.push({
      role: "user",
      label: "synopses",
      text: `# The story so far\n${input.synopses.map((s) => `## ${s.title}\n${s.synopsis}`).join("\n\n")}`,
    });
  }
  blocks.push({
    role: "user",
    label: "book KB",
    text: bookKbBlock(input.bookKb || "(empty so far)"),
  });
  const part = input.part ? ` (part ${input.part.index + 1} of ${input.part.count})` : "";
  blocks.push({
    role: "user",
    label: "chapter",
    text: `# Chapter: ${input.chapterTitle}${part}\n\n${input.chapterText}`,
  });
  return blocks;
}

export function reviewBlocks(input: {
  targetName: string;
  languageNotes: string;
  referenceKb: string | null;
  synopses: { title: string; synopsis: string }[];
  bookKb: string;
  focus: string;
}): PromptBlock[] {
  const blocks: PromptBlock[] = [
    {
      role: "system",
      label: "instructions",
      text: `You review a knowledge base prepared for translating an English novel into ${input.targetName}, now that the whole book has been read. Fix it with edits:
- merge duplicates (remove one, add its spellings as aliases of the other);
- make translations of related names and terms consistent;
- resolve open questions that the synopses answer; leave the rest open;
- remove entries that are ordinary words and not worth keeping.
Refer to entries by id (p1 …). Don't change entries marked [locked]. Return no edits if nothing needs fixing. Every edit needs a short reason.${languageNotesBlock(input.targetName, input.languageNotes)}`,
    },
  ];
  if (input.referenceKb)
    blocks.push({
      role: "user",
      label: "reference KBs",
      text: referenceKbBlock(input.referenceKb),
    });
  blocks.push({
    role: "user",
    label: "synopses",
    text: `# The whole story, chapter by chapter\n${input.synopses.map((s) => `## ${s.title}\n${s.synopsis}`).join("\n\n")}`,
  });
  blocks.push({
    role: "user",
    label: "book KB",
    text: bookKbBlock(input.bookKb),
    cacheBreakpoint: true,
  });
  blocks.push({ role: "user", label: "focus", text: `# Review now\n${input.focus}` });
  return blocks;
}
