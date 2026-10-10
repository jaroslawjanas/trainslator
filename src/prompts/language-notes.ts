import { z } from "zod";
import type { PromptBlock } from "../llm/request.ts";

export const LANGUAGE_NOTES_VERSION = 1;

export const LanguageNotesOutput = z.object({
  markdown: z.string(),
});

export function languageNotesBlocks(
  sourceName: string,
  targetName: string,
  targetTag: string,
): PromptBlock[] {
  return [
    {
      role: "system",
      label: "instructions",
      text: `You are an expert literary translator and linguist. You write short, practical guidance for translators of fiction from ${sourceName} into ${targetName} (${targetTag}).`,
    },
    {
      role: "user",
      label: "task",
      text: `Write concise notes (Markdown, at most about 400 words) listing what a translator of novels from ${sourceName} into ${targetName} must track and decide consistently. Cover only what applies to ${targetName}, for example:
- grammatical gender, number and case, and which facts about characters they depend on (e.g. a character's gender affecting verb forms);
- formal and informal address and how relationships between characters affect it;
- honorifics, titles and kinship terms;
- how foreign names are written, adapted, transliterated or inflected;
- name order and writing system;
- quotation and dialogue punctuation, spacing rules, number and date formats;
- anything else a translator commonly gets wrong for this language.
End with a section "Attributes to record" listing the attribute keys (in English, lowercase, e.g. gender, address, honorific) that a knowledge base should store for names and terms in ${targetName}.
Return JSON: {"markdown": "..."}.`,
    },
  ];
}
