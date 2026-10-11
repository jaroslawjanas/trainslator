import { describe, expect, it } from "vitest";
import { sourceLanguage } from "../languages/index.ts";
import type { PromptBlock } from "../llm/request.ts";
import { toStrictJsonSchema } from "../llm/structured.ts";
import { AlignOutput, alignBlocks } from "../prompts/alignment.ts";
import { KbAnswer, kbQuestionBlocks } from "../prompts/kb-question.ts";
import { LanguageNotesOutput, languageNotesBlocks } from "../prompts/language-notes.ts";
import {
  MergeOutput,
  mergeSystem,
  ReadOutput,
  readBlocks,
  StyleOutput,
  styleBlocks,
} from "../prompts/phase1.ts";
import { ChapterOutput, chapterBlocks, ReviewOutput, reviewBlocks } from "../prompts/phase2.ts";
import { Phase3Output, phase3Blocks, TocOutput, tocBlocks } from "../prompts/phase3.ts";
import { RewriteOutput, rewriteBlocks } from "../prompts/rewrite.ts";
import type { Segment } from "../shared/schemas/epub.ts";

/**
 * The exact prompts and output schemas an English project sends. Saved
 * answers and phase 1's reuse of finished chapters are keyed by these bytes,
 * so they must never change by accident: these files are compared byte for
 * byte. Only update them on purpose (vitest -u), knowing that English
 * projects will then ask the models again.
 */

const golden = (name: string) => `./__golden__/en/${name}.txt`;
const EN = sourceLanguage("en");

function show(blocks: PromptBlock[]): string {
  return `${blocks
    .map((b) => `=== ${b.role} | ${b.label}${b.cacheBreakpoint ? " | cache" : ""} ===\n${b.text}`)
    .join("\n\n")}\n`;
}

const NOTES = "## Grammatical gender\nPast-tense verbs depend on a character's gender.";
const REF_KB = '### From "Earlier Book"\n## Characters\n- Mira → Mira (kept) [gender: female]';
const BOOK_KB = "## Characters\n- [p1] Mira → Mira (kept) [gender: female]";

function segment(i: number, title: string, words: number, start: string): Segment {
  return {
    id: `d1s${i}`,
    index: i,
    title,
    depth: 1,
    linear: true,
    ranges: [],
    words,
    preview: { start, end: "" },
    guess: "body",
  };
}

describe("English prompts stay byte-identical", () => {
  it("phase 1: reading a chapter pair", async () => {
    const whole = readBlocks({
      source: EN,
      targetName: "Polish",
      languageNotes: NOTES,
      sourceText: "Mira climbed the lighthouse.",
      targetText: "Mira wspięła się na latarnię.",
      part: null,
    });
    const part = readBlocks({
      source: EN,
      targetName: "Polish",
      languageNotes: "",
      sourceText: "The storm came.",
      targetText: "Przyszedł sztorm.",
      part: { index: 1, count: 3 },
    });
    await expect(show(whole)).toMatchFileSnapshot(golden("phase1-read"));
    await expect(show(part)).toMatchFileSnapshot(golden("phase1-read-part"));
  });

  it("phase 1: merging and style", async () => {
    await expect(`${mergeSystem(EN, "Polish", NOTES)}\n`).toMatchFileSnapshot(
      golden("phase1-merge"),
    );
    await expect(
      show(styleBlocks(EN, "Polish", NOTES, "- Dialogue uses dashes (3)")),
    ).toMatchFileSnapshot(golden("phase1-style"));
  });

  it("phase 2: reading and the final review", async () => {
    const withRef = chapterBlocks({
      source: EN,
      targetName: "Polish",
      languageNotes: NOTES,
      referenceKb: REF_KB,
      synopses: [{ title: "Chapter One", synopsis: "Mira keeps the lighthouse." }],
      bookKb: BOOK_KB,
      chapterTitle: "Chapter Two",
      chapterText: "The storm came at midnight.",
      part: { index: 0, count: 2 },
    });
    const noRef = chapterBlocks({
      source: EN,
      targetName: "Polish",
      languageNotes: "",
      referenceKb: null,
      synopses: [],
      bookKb: "",
      chapterTitle: "Chapter One",
      chapterText: "Mira climbed the lighthouse.",
      part: null,
    });
    const review = reviewBlocks({
      source: EN,
      targetName: "Polish",
      languageNotes: NOTES,
      referenceKb: REF_KB,
      synopses: [{ title: "Chapter One", synopsis: "Mira keeps the lighthouse." }],
      bookKb: BOOK_KB,
      focus: "Characters (p1 to p3).",
    });
    await expect(show(withRef)).toMatchFileSnapshot(golden("phase2-chapter"));
    await expect(show(noRef)).toMatchFileSnapshot(golden("phase2-chapter-first"));
    await expect(show(review)).toMatchFileSnapshot(golden("phase2-review"));
  });

  it("alignment with AI and language notes", async () => {
    const align = alignBlocks(
      EN,
      "Polish",
      [segment(0, "Chapter One", 1200, "Mira climbed"), segment(1, "Notes", 40, "1. The ships")],
      [segment(0, "Rozdział pierwszy", 1100, "Mira wspięła się")],
    );
    await expect(show(align)).toMatchFileSnapshot(golden("alignment"));
    await expect(show(languageNotesBlocks(EN, "Polish", "pl"))).toMatchFileSnapshot(
      golden("language-notes"),
    );
  });

  it("phase 3, the table of contents, rewriting and open questions", async () => {
    const base = {
      sourceName: "English",
      targetName: "Polish",
      targetTag: "pl",
      languageNotes: NOTES,
      referenceKb: REF_KB,
      bookKb: BOOK_KB,
      glossary: [{ source: "Gray Heron", target: "Szara Czapla", note: "a ship" }],
      synopsis: "Mira keeps the lighthouse.",
      units: [
        { id: "u1", text: "Mira climbed the <g1>hundred</g1> steps.", keep: [] },
        { id: "u2", text: "See the note.<x1/>", keep: ["<x1/>"] },
      ],
      instruction: null,
    };
    const chunk = phase3Blocks({
      ...base,
      previous: [{ source: "It was late.", translation: "Było późno." }],
    });
    const chapter = phase3Blocks({
      ...base,
      previous: [],
      storySoFar: ["Mira arrives.", "The storm comes."],
      chapterText: "[part to translate]\nMira climbed the hundred steps.",
      translatedSoFar: ["Mira weszła na górę."],
      instruction: "more formal",
    });
    const toc = tocBlocks({
      sourceName: "English",
      targetName: "Polish",
      targetTag: "pl",
      languageNotes: NOTES,
      bookKb: BOOK_KB,
      headings: [{ source: "Chapter One", translation: "Rozdział pierwszy" }],
      items: [{ id: "u1", text: "Contents", keep: [] }],
    });
    const rewrite = rewriteBlocks({
      sourceName: "English",
      targetName: "Polish",
      targetTag: "pl",
      languageNotes: NOTES,
      referenceKb: REF_KB,
      bookKb: BOOK_KB,
      around: {
        before: [{ source: "It was late.", translation: "Było późno." }],
        after: [],
      },
      source: "Mira climbed the steps.",
      translation: "Mira ⟦weszła⟧ po schodach.",
      fragment: true,
      instruction: "more natural",
    });
    const question = kbQuestionBlocks({
      sourceName: "English",
      targetName: "Polish",
      languageNotes: NOTES,
      referenceKb: REF_KB,
      ownKb: BOOK_KB,
      synopses: ["Mira keeps the lighthouse."],
      entry: '{"source":"Pepper","target":null}',
      question: "Is the cat male or female?",
    });
    await expect(show(chunk)).toMatchFileSnapshot(golden("phase3-chunk"));
    await expect(show(chapter)).toMatchFileSnapshot(golden("phase3-chapter"));
    await expect(show(toc)).toMatchFileSnapshot(golden("phase3-toc"));
    await expect(show(rewrite)).toMatchFileSnapshot(golden("rewrite"));
    await expect(show(question)).toMatchFileSnapshot(golden("kb-question"));
  });

  it("output schemas", async () => {
    const schemas = {
      ReadOutput,
      MergeOutput,
      StyleOutput,
      ChapterOutput,
      ReviewOutput,
      AlignOutput,
      LanguageNotesOutput,
      Phase3Output,
      TocOutput,
      RewriteOutput,
      KbAnswer,
    };
    const text = Object.entries(schemas)
      .map(([name, s]) => `=== ${name} ===\n${JSON.stringify(toStrictJsonSchema(s), null, 2)}`)
      .join("\n\n");
    await expect(`${text}\n`).toMatchFileSnapshot(golden("schemas"));
  });
});
