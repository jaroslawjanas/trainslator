import type { Element } from "domhandler";
import { resolveHref } from "./package.ts";
import {
  collapseSpaces,
  findAll,
  findFirst,
  getAttr,
  isElement,
  localName,
  parseXml,
  semanticTypes,
  textContent,
} from "./xhtml.ts";

export interface TocEntry {
  title: string;
  /** 1 = top level. */
  depth: number;
  /** Resolved archive path, or null for unlinked headings. */
  path: string | null;
  fragment: string | null;
  /** Index of the entry in the flattened list. */
  order: number;
  /** Index of the parent entry, or null. */
  parent: number | null;
}

function cleanTitle(text: string): string {
  return collapseSpaces(text).trim();
}

/** Parses the EPUB 3 navigation document's `toc` nav. */
export function parseNavToc(navSrc: string, navPath: string): TocEntry[] {
  const doc = parseXml(navSrc);
  const navs = findAll(doc, (el) => localName(el) === "nav");
  const tocNav =
    navs.find((n) => semanticTypes(n).some((t) => t === "toc" || t === "doc-toc")) ?? navs[0];
  if (!tocNav) return [];
  const entries: TocEntry[] = [];

  function walkList(list: Element, depth: number, parent: number | null): void {
    for (const li of list.children) {
      if (!isElement(li) || localName(li) !== "li") continue;
      const link = li.children.find(
        (c): c is Element => isElement(c) && (localName(c) === "a" || localName(c) === "span"),
      );
      let index: number | null = parent;
      if (link) {
        const href = localName(link) === "a" ? getAttr(link, "href") : undefined;
        const resolved = href ? resolveHref(navPath, href) : null;
        index = entries.length;
        entries.push({
          title: cleanTitle(textContent(link)),
          depth,
          path: resolved?.path ?? null,
          fragment: resolved?.fragment ?? null,
          order: index,
          parent,
        });
      }
      const nested = li.children.find((c): c is Element => isElement(c) && localName(c) === "ol");
      if (nested) walkList(nested, link ? depth + 1 : depth, index);
    }
  }

  const topList = findFirst(tocNav, (el) => localName(el) === "ol");
  if (topList) walkList(topList, 1, null);
  return entries;
}

/** Parses an EPUB 2 NCX navMap. */
export function parseNcx(ncxSrc: string, ncxPath: string): TocEntry[] {
  const doc = parseXml(ncxSrc);
  const navMap = findFirst(doc, (el) => localName(el) === "navmap");
  if (!navMap) return [];
  const entries: TocEntry[] = [];

  function walk(el: Element, depth: number, parent: number | null): void {
    for (const child of el.children) {
      if (!isElement(child) || localName(child) !== "navpoint") continue;
      const label = findFirst(child, (e) => localName(e) === "text");
      const content = child.children.find(
        (c): c is Element => isElement(c) && localName(c) === "content",
      );
      const src = content ? getAttr(content, "src") : undefined;
      const resolved = src ? resolveHref(ncxPath, src) : null;
      const index = entries.length;
      entries.push({
        title: cleanTitle(label ? textContent(label) : ""),
        depth,
        path: resolved?.path ?? null,
        fragment: resolved?.fragment ?? null,
        order: index,
        parent,
      });
      walk(child, depth + 1, index);
    }
  }

  walk(navMap, 1, null);
  return entries;
}

/** Prefers the nav document unless the NCX has many more entries. */
export function chooseToc(
  nav: TocEntry[],
  ncx: TocEntry[],
): { entries: TocEntry[]; source: "nav" | "ncx" | "none" } {
  if (nav.length === 0 && ncx.length === 0) return { entries: [], source: "none" };
  if (nav.length === 0) return { entries: ncx, source: "ncx" };
  if (ncx.length > nav.length * 1.5 && ncx.length - nav.length >= 3)
    return { entries: ncx, source: "ncx" };
  return { entries: nav, source: "nav" };
}
