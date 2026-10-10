import type { AnyNode } from "domhandler";
import type { UnitRange } from "../shared/schemas/epub.ts";
import type { EpubBook } from "./book.ts";
import type { FlowUnit } from "./flow.ts";
import { segmentUnits } from "./segments.ts";
import {
  classify,
  collapseSpaces,
  decodeText,
  getAttr,
  isElement,
  localName,
  removeSoftHyphens,
  semanticTypes,
  textContent,
} from "./xhtml.ts";

/**
 * Lightweight Markdown used in phases 1–2: keeps paragraphs, headings,
 * emphasis, line breaks, lists, quotes and footnote markers; drops styling.
 */

const NOTEREF = ["noteref", "doc-noteref"];
const PAGEBREAK = ["pagebreak", "doc-pagebreak"];
const ITALIC = new Set(["i", "em", "cite", "var", "dfn"]);
const BOLD = new Set(["b", "strong"]);

export function looksLikeFileName(text: string): boolean {
  return /^[\w.-]+\.(jpe?g|png|gif|svg|webp|bmp|tiff?)$/i.test(text.trim());
}

function inline(nodes: AnyNode[], pre: boolean): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      const t = removeSoftHyphens(decodeText(node.data));
      out += pre ? t : collapseSpaces(t);
      continue;
    }
    if (node.type === "cdata") {
      out += textContent(node);
      continue;
    }
    if (!isElement(node)) continue;
    const name = localName(node);
    const cls = classify(node);
    if (cls === "skip") continue;
    if (name === "wbr") continue;
    if (name === "br") {
      out += "\n";
      continue;
    }
    if (name === "img" || name === "image") {
      const alt = decodeText(getAttr(node, "alt") ?? "").trim();
      if (alt && !looksLikeFileName(alt)) out += `[image: ${alt}]`;
      continue;
    }
    if (cls === "atomic") continue;
    const types = semanticTypes(node);
    if (types.some((t) => PAGEBREAK.includes(t))) continue;
    if (types.some((t) => NOTEREF.includes(t))) {
      const label = collapseSpaces(textContent(node)).trim();
      out += label ? `[^${label}]` : "";
      continue;
    }
    const inner = inline(node.children, pre);
    if (!inner.trim()) {
      out += inner;
      continue;
    }
    if (ITALIC.has(name)) out += wrapPreservingSpace(inner, "*");
    else if (BOLD.has(name)) out += wrapPreservingSpace(inner, "**");
    else out += inner;
  }
  return out;
}

function wrapPreservingSpace(text: string, mark: string): string {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const trail = /\s*$/.exec(text)?.[0] ?? "";
  return `${lead}${mark}${text.trim()}${mark}${trail}`;
}

export function renderUnitMarkdown(unit: FlowUnit): string {
  if (unit.kind === "break") return "* * *";
  if (unit.role === "title") return "";
  let body = inline(unit.nodes, unit.pre);
  body = unit.pre
    ? body.replace(/^\n+|\n+$/g, "")
    : body
        .split("\n")
        .map((l) => l.trim())
        .join("\n")
        .trim();
  if (!body) return "";
  let prefix = "";
  if (unit.role === "heading") prefix = `${"#".repeat(Math.max(1, unit.headingLevel))} `;
  else if (unit.role === "list-item") prefix = `${"  ".repeat(Math.max(0, unit.listDepth - 1))}- `;
  else if (unit.role === "table-cell") prefix = "| ";
  if (unit.inFootnote) prefix = `[note] ${prefix}`;
  if (unit.quoteDepth > 0) {
    const q = "> ".repeat(unit.quoteDepth);
    return body
      .split("\n")
      .map((line, i) => (i === 0 ? `${q}${prefix}${line}` : `${q}${line}`))
      .join("\n");
  }
  return `${prefix}${body}`;
}

/** Markdown for a segment (or any list of unit ranges). */
export function renderRangesMarkdown(book: EpubBook, ranges: UnitRange[]): string {
  return segmentUnits(book, ranges)
    .map(({ unit }) => renderUnitMarkdown(unit))
    .filter(Boolean)
    .join("\n\n");
}
