import { z } from "zod";
import type { PromptBlock } from "../llm/request.ts";
import type { Segment } from "../shared/schemas/epub.ts";
import { jsonLines } from "./common.ts";

export const ALIGNMENT_PROMPT_VERSION = 1;

export const AlignOutput = z.object({
  units: z.array(
    z.object({
      source: z.array(z.string()).describe("ids of English segments (S…), or an empty list"),
      target: z.array(z.string()).describe("ids of translated segments (T…), or an empty list"),
      include: z
        .boolean()
        .describe("true for chapter or story text that both books contain, otherwise false"),
    }),
  ),
});
export type AlignOutput = z.infer<typeof AlignOutput>;

const OPENING_CHARS = 160;

function segmentLines(prefix: string, segments: Segment[]): string {
  return jsonLines(
    segments.map((s, i) => ({
      id: `${prefix}${i + 1}`,
      title: s.title,
      words: s.words,
      opening: s.preview.start.slice(0, OPENING_CHARS),
    })),
  );
}

export function alignBlocks(
  targetName: string,
  source: Segment[],
  target: Segment[],
): PromptBlock[] {
  return [
    {
      role: "system",
      label: "instructions",
      text: `You match the chapters of an English book with the chapters of its published ${targetName} translation, so the two can be studied side by side.

You get both books' segments in book order. Each has an id, a title, a word count and the opening words of its text.

Return the matching as a list of units in book order:
- usually one English segment with one translated segment;
- a chapter split differently in the two books takes several consecutive ids on one side;
- a segment that only one book has (a cover, a title page, a licence, notes, a publisher's page, a story missing from the other book) gets a unit of its own with an empty list on the other side.
Every id appears exactly once, and the ids on each side stay in book order.
Set "include" to true for chapter or story text that both books contain, and false for everything else (front and back matter, tables of contents, unmatched segments).
Use titles, opening words, names and lengths. A translation is usually somewhat shorter or longer than the English, but the ratio stays similar from chapter to chapter.`,
    },
    {
      role: "user",
      label: "segments",
      text: `## English book\n${segmentLines("S", source)}\n\n## ${targetName} translation\n${segmentLines("T", target)}`,
    },
  ];
}
