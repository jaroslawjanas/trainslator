import { describe, expect, it } from "vitest";
import { buildFixtureEpub, sampleNovel } from "../testing/epub-fixtures.ts";
import { EpubBook } from "./book.ts";
import { buildSegments } from "./segments.ts";
import { renderRangesMarkdown } from "./text.ts";

const para = (n: number, word = "word") =>
  `<p>${Array.from({ length: n }, () => word).join(" ")}.</p>`;

describe("segments", () => {
  it("follows the TOC, including anchors inside files", () => {
    const book = EpubBook.open(sampleNovel());
    const { segmentsByDepth, maxDepth } = buildSegments(book, "en");
    expect(maxDepth).toBe(2);
    expect(segmentsByDepth["1"]!.map((s) => s.title)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Notes",
    ]);
    expect(segmentsByDepth["2"]!.map((s) => s.title)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Second Scene",
      "Notes",
    ]);
    const notes = segmentsByDepth["1"]!.find((s) => s.title === "Notes")!;
    expect(notes.linear).toBe(false);
    expect(notes.guess).toBe("back");
  });

  it("splits one file with several chapters and joins a chapter split across files", () => {
    const book = EpubBook.open(
      buildFixtureEpub({
        docs: [
          { path: "a.xhtml", body: `<h2 id="c1">One</h2>${para(5)}<h2 id="c2">Two</h2>${para(5)}` },
          { path: "b.xhtml", body: para(5, "more") },
          { path: "c.xhtml", body: `<h2>Three</h2>${para(5)}` },
        ],
        toc: [
          { title: "One", href: "a.xhtml#c1" },
          { title: "Two", href: "a.xhtml#c2" },
          { title: "Three", href: "c.xhtml" },
        ],
      }),
    );
    const segs = buildSegments(book, "en").segmentsByDepth["1"]!;
    expect(segs.map((s) => s.title)).toEqual(["One", "Two", "Three"]);
    expect(segs[1]!.ranges.map((r) => r.docIndex)).toEqual([0, 1]);
  });

  it("falls back to the start of the file for a missing anchor and reports it", () => {
    const book = EpubBook.open(
      buildFixtureEpub({
        docs: [
          { path: "a.xhtml", body: `<h2>One</h2>${para(3)}` },
          { path: "b.xhtml", body: `<h2>Two</h2>${para(3)}` },
        ],
        toc: [
          { title: "One", href: "a.xhtml" },
          { title: "Two", href: "b.xhtml#nowhere" },
        ],
      }),
    );
    const result = buildSegments(book, "en");
    expect(result.segmentsByDepth["1"]!.map((s) => s.title)).toEqual(["One", "Two"]);
    expect(result.diagnostics.some((d) => d.code === "toc-anchor-missing")).toBe(true);
  });

  it("uses one segment per file when the TOC isn't usable", () => {
    const book = EpubBook.open(
      buildFixtureEpub({
        docs: [
          { path: "a.xhtml", body: `<h2>Alpha</h2>${para(3)}` },
          { path: "b.xhtml", body: `<h2>Beta</h2>${para(3)}` },
        ],
        toc: [{ title: "Only", href: "a.xhtml" }],
      }),
    );
    expect(buildSegments(book, "en").segmentsByDepth["1"]!.map((s) => s.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("starts unlinked TOC headings at their first child", () => {
    const book = EpubBook.open(
      buildFixtureEpub({
        docs: [
          { path: "p1.xhtml", body: `<h1>Part</h1>` },
          { path: "a.xhtml", body: `<h2>One</h2>${para(3)}` },
          { path: "b.xhtml", body: `<h2>Two</h2>${para(3)}` },
        ],
        toc: [
          {
            title: "Part One",
            href: null,
            children: [
              { title: "One", href: "a.xhtml" },
              { title: "Two", href: "b.xhtml" },
            ],
          },
        ],
      }),
    );
    const result = buildSegments(book, "en");
    // At depth 1 there is only one start point, so files are used instead.
    expect(result.segmentsByDepth["1"]!.map((s) => s.title)).toEqual(["Part", "One", "Two"]);
    // At depth 2 the part heading and its first chapter start at the same place; the outer title wins.
    expect(result.segmentsByDepth["2"]!.map((s) => s.title)).toEqual([
      "Front matter",
      "Part One",
      "Two",
    ]);
  });
});

describe("markdown text", () => {
  it("renders headings, emphasis, notes, breaks and lists", () => {
    const book = EpubBook.open(sampleNovel());
    const seg = buildSegments(book, "en").segmentsByDepth["1"]![0]!;
    const md = renderRangesMarkdown(book, seg.ranges);
    expect(md).toContain("# Chapter One\nThe Lamp");
    expect(md).toContain("She kept a *small* notebook");
    expect(md).toContain("*Morning Bell*.[^1]");
    expect(md).toContain("> A quoted line");
    expect(md).toContain("- First item");
    expect(md).toContain("  - Nested item");
    expect(md).toContain("Water\nand salt");
    expect(md).not.toContain("hidden note");
  });
});
