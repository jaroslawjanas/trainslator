import { describe, expect, it } from "vitest";
import { sourceLanguage } from "../languages/index.ts";
import type { PromptBlock } from "../llm/request.ts";
import { toStrictJsonSchema } from "../llm/structured.ts";
import { alignBlocks, alignOutputFor } from "../prompts/alignment.ts";
import { languageNotesBlocks } from "../prompts/language-notes.ts";
import { mergeSystem, readBlocks, readOutputFor, styleBlocks } from "../prompts/phase1.ts";
import { chapterBlocks, reviewBlocks } from "../prompts/phase2.ts";
import { phase3System } from "../prompts/phase3.ts";
import type { Segment } from "../shared/schemas/epub.ts";

/** The prompts German and Polish sources get: English ones with the language named, plus the base-form rules. */

function show(blocks: PromptBlock[]): string {
  return `${blocks.map((b) => `=== ${b.role} | ${b.label} ===\n${b.text}`).join("\n\n")}\n`;
}

const segment = (i: number, title: string): Segment => ({
  id: `d1s${i}`,
  index: i,
  title,
  depth: 1,
  linear: true,
  ranges: [],
  words: 1000,
  preview: { start: "…", end: "" },
  guess: "body",
});

describe.each(["de", "pl"])("prompts for a %s source", (tag) => {
  const source = sourceLanguage(tag);
  const golden = (name: string) => `./__golden__/${tag}/${name}.txt`;

  it("name the source language and ask for base forms", async () => {
    const text = [
      show(
        readBlocks({
          source,
          targetName: "English",
          languageNotes: "",
          sourceText: "…",
          targetText: "…",
          part: { index: 0, count: 2 },
        }),
      ),
      mergeSystem(source, "English", ""),
      show(styleBlocks(source, "English", "", "- notes")),
      show(
        chapterBlocks({
          source,
          targetName: "English",
          languageNotes: "",
          referenceKb: null,
          synopses: [],
          bookKb: "",
          chapterTitle: "1",
          chapterText: "…",
          part: null,
        }),
      ),
      show(
        reviewBlocks({
          source,
          targetName: "English",
          languageNotes: "",
          referenceKb: null,
          synopses: [],
          bookKb: "",
          focus: "…",
        }),
      ),
      show(alignBlocks(source, "English", [segment(0, "1")], [segment(0, "1")])),
      show(languageNotesBlocks(source, "English", "en")),
      phase3System(source.name, "English", "en", "", true),
      JSON.stringify(toStrictJsonSchema(readOutputFor(source)), null, 2),
      JSON.stringify(toStrictJsonSchema(alignOutputFor(source)), null, 2),
    ].join("\n\n");
    expect(text).not.toContain("English novel");
    expect(text).toContain(`${source.name} base form`);
    await expect(`${text}\n`).toMatchFileSnapshot(golden("prompts"));
  });
});
