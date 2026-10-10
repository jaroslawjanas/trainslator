import type { AnyNode, Document, Element } from "domhandler";
import {
  classify,
  collapseSpaces,
  decodeText,
  elementId,
  elementRanges,
  getAttr,
  hasBlockDescendant,
  isBlockLike,
  isElement,
  localName,
  nodeRange,
  removeSoftHyphens,
  semanticTypes,
  textContent,
} from "./xhtml.ts";

/**
 * The document flow: one ordered list of text units per XHTML document.
 * Chapter segmentation, phase 1–2 text and phase 3 translation units all read
 * this same list, so they always agree on what belongs where.
 */

export type UnitRole =
  | "heading"
  | "paragraph"
  | "list-item"
  | "table-cell"
  | "caption"
  | "title"
  | "preformatted"
  | "break";

export interface FlowUnit {
  index: number;
  /** element = a block whose content is all inline; run = inline content between blocks; break = <hr>. */
  kind: "element" | "run" | "break";
  /** Local name of the block element, for element units. */
  tag: string | null;
  role: UnitRole;
  headingLevel: number;
  listDepth: number;
  quoteDepth: number;
  inFootnote: boolean;
  /** Content range [start, end) in the decoded source. */
  start: number;
  end: number;
  /** For element units: range of the whole element including its tags. */
  elStart: number | null;
  elEnd: number | null;
  /** The block element, for element units. */
  element: Element | null;
  /** Nodes that make up the content (children of the block, or the run's nodes). */
  nodes: AnyNode[];
  /** Ids on the block element and inside the content. */
  ids: string[];
  pre: boolean;
  safe: boolean;
  unsafeReason: string | null;
  /** Decoded plain text (spaces collapsed unless preformatted). */
  text: string;
  hasLetters: boolean;
}

export interface DocFlow {
  src: string;
  dom: Document;
  units: FlowUnit[];
  /** id → index of the unit containing it, or the first unit after it. */
  idToUnit: Map<string, number>;
  /** Elements whose language attribute was found, for lang rewriting. */
  hasBody: boolean;
}

export interface FlowOptions {
  /** Class names styled with `white-space: pre…` in the book's CSS. */
  preClasses: Set<string>;
  /** Navigation document: the toc/landmarks/page-list navs are skipped. */
  isNav: boolean;
}

interface Ctx {
  listDepth: number;
  quoteDepth: number;
  inFootnote: boolean;
  pre: boolean;
  /** Role for loose text directly inside the current container (e.g. text of an <li> with a nested list). */
  runRole: UnitRole | null;
  runHeadingLevel: number;
}

function containerRunRole(
  tag: string,
  parent: Ctx,
): { runRole: UnitRole | null; runHeadingLevel: number } {
  const h = HEADING.exec(tag);
  if (h) return { runRole: "heading", runHeadingLevel: Number(h[1]) };
  if (tag === "li" || tag === "dt" || tag === "dd")
    return { runRole: "list-item", runHeadingLevel: 0 };
  if (tag === "td" || tag === "th") return { runRole: "table-cell", runHeadingLevel: 0 };
  if (tag === "caption" || tag === "figcaption") return { runRole: "caption", runHeadingLevel: 0 };
  if (BLOCK_LIKE_RESET.has(tag)) return { runRole: null, runHeadingLevel: 0 };
  return { runRole: parent.runRole, runHeadingLevel: parent.runHeadingLevel };
}

const BLOCK_LIKE_RESET = new Set([
  "div",
  "section",
  "article",
  "aside",
  "blockquote",
  "body",
  "main",
  "header",
  "footer",
  "figure",
]);

const HEADING = /^h([1-6])$/;
const NOTE_TYPES = ["footnote", "endnote", "rearnote", "note", "doc-footnote", "doc-endnote"];
const NAV_SKIP_TYPES = ["toc", "landmarks", "page-list", "doc-toc", "doc-pagelist"];

function styleIsPre(el: Element, preClasses: Set<string>): boolean {
  if (localName(el) === "pre") return true;
  const style = getAttr(el, "style");
  if (style && /white-space\s*:\s*pre/i.test(style)) return true;
  const cls = getAttr(el, "class");
  if (cls && preClasses.size > 0) {
    for (const c of cls.split(/\s+/)) if (preClasses.has(c)) return true;
  }
  return false;
}

function roleFor(tag: string, ctx: Ctx): { role: UnitRole; headingLevel: number } {
  const h = HEADING.exec(tag);
  if (h) return { role: "heading", headingLevel: Number(h[1]) };
  if (tag === "li" || tag === "dt" || tag === "dd") return { role: "list-item", headingLevel: 0 };
  if (tag === "td" || tag === "th") return { role: "table-cell", headingLevel: 0 };
  if (tag === "caption" || tag === "figcaption" || tag === "legend" || tag === "summary") {
    return { role: "caption", headingLevel: 0 };
  }
  if (tag === "title") return { role: "title", headingLevel: 0 };
  if (ctx.pre) return { role: "preformatted", headingLevel: 0 };
  return { role: "paragraph", headingLevel: 0 };
}

function collectIds(nodes: AnyNode[], out: string[]): void {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    const id = elementId(node);
    if (id) out.push(id);
    collectIds(node.children, out);
  }
}

/** Every element in `nodes` must have trustworthy ranges, or edits could corrupt the file. */
export function checkSafe(src: string, nodes: AnyNode[]): string | null {
  for (const node of nodes) {
    if (isElement(node)) {
      if (!elementRanges(src, node)) return `<${node.name}> isn't closed properly`;
      if (classify(node) === "atomic") continue;
      const inner = checkSafe(src, node.children);
      if (inner) return inner;
    } else if (node.type === "text" || node.type === "comment" || node.type === "directive") {
      if (!nodeRange(node)) return "missing position information";
    }
  }
  return null;
}

export function plainText(nodes: AnyNode[], pre: boolean): string {
  const raw = removeSoftHyphens(nodes.map(textContent).join(""));
  return pre ? raw : collapseSpaces(raw).trim();
}

export function buildFlow(src: string, dom: Document, options: FlowOptions): DocFlow {
  const units: FlowUnit[] = [];
  const idPositions: { id: string; pos: number }[] = [];
  let hasBody = false;

  function recordIds(node: AnyNode): void {
    if (!isElement(node)) return;
    const id = elementId(node);
    if (id && node.startIndex !== null) idPositions.push({ id, pos: node.startIndex });
    for (const child of node.children) recordIds(child);
  }

  function pushUnit(unit: Omit<FlowUnit, "index">): void {
    units.push({ ...unit, index: units.length });
  }

  function emitRun(nodes: AnyNode[], ctx: Ctx): void {
    if (nodes.length === 0) return;
    const text = plainText(nodes, ctx.pre);
    if (!/\S/.test(text)) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const firstRange = nodeRange(first);
    const lastRange = nodeRange(last);
    const ids: string[] = [];
    collectIds(nodes, ids);
    const unsafe = firstRange && lastRange ? checkSafe(src, nodes) : "missing position information";
    pushUnit({
      kind: "run",
      tag: null,
      role: ctx.runRole ?? (ctx.pre ? "preformatted" : "paragraph"),
      headingLevel: ctx.runRole === "heading" ? ctx.runHeadingLevel : 0,
      listDepth: ctx.listDepth,
      quoteDepth: ctx.quoteDepth,
      inFootnote: ctx.inFootnote,
      start: firstRange?.[0] ?? 0,
      end: lastRange?.[1] ?? 0,
      elStart: null,
      elEnd: null,
      element: null,
      nodes,
      ids,
      pre: ctx.pre,
      safe: unsafe === null,
      unsafeReason: unsafe,
      text,
      hasLetters: /\p{L}/u.test(text),
    });
  }

  function emitElement(el: Element, ctx: Ctx): void {
    const tag = localName(el);
    const text = plainText(el.children, ctx.pre);
    if (!/\S/.test(text)) return;
    const ranges = elementRanges(src, el);
    const ids: string[] = [];
    const ownId = elementId(el);
    if (ownId) ids.push(ownId);
    collectIds(el.children, ids);
    const unsafe = ranges ? checkSafe(src, el.children) : `<${el.name}> isn't closed properly`;
    const { role, headingLevel } = roleFor(tag, ctx);
    pushUnit({
      kind: "element",
      tag,
      role,
      headingLevel,
      listDepth: ctx.listDepth,
      quoteDepth: ctx.quoteDepth,
      inFootnote: ctx.inFootnote,
      start: ranges?.innerStart ?? el.startIndex ?? 0,
      end: ranges?.innerEnd ?? (el.endIndex ?? 0) + 1,
      elStart: ranges?.start ?? el.startIndex,
      elEnd: ranges?.end ?? (el.endIndex === null ? null : el.endIndex + 1),
      element: el,
      nodes: el.children,
      ids,
      pre: ctx.pre,
      safe: unsafe === null,
      unsafeReason: unsafe,
      text,
      hasLetters: /\p{L}/u.test(text),
    });
  }

  function visitContainer(el: Element, ctx: Ctx): void {
    let run: AnyNode[] = [];
    for (const child of el.children) {
      if (isBlockLike(child)) {
        emitRun(run, ctx);
        run = [];
        visitBlock(child, ctx);
      } else {
        run.push(child);
      }
    }
    emitRun(run, ctx);
  }

  function visitBlock(el: Element, parent: Ctx): void {
    const tag = localName(el);
    const cls = classify(el);
    if (cls === "skip") return;

    if (tag === "head") {
      recordIds(el);
      for (const child of el.children) {
        if (isElement(child) && localName(child) === "title") emitElement(child, parent);
      }
      return;
    }
    if (tag === "body") hasBody = true;

    const types = semanticTypes(el);
    if (tag === "nav" && options.isNav && types.some((t) => NAV_SKIP_TYPES.includes(t))) {
      recordIds(el);
      return;
    }

    const elId = elementId(el);
    if (elId && el.startIndex !== null) idPositions.push({ id: elId, pos: el.startIndex });

    if (tag === "hr") {
      const ranges = elementRanges(src, el);
      pushUnit({
        kind: "break",
        tag,
        role: "break",
        headingLevel: 0,
        listDepth: parent.listDepth,
        quoteDepth: parent.quoteDepth,
        inFootnote: parent.inFootnote,
        start: ranges?.start ?? el.startIndex ?? 0,
        end: ranges?.end ?? (el.endIndex ?? 0) + 1,
        elStart: ranges?.start ?? null,
        elEnd: ranges?.end ?? null,
        element: el,
        nodes: [],
        ids: elId ? [elId] : [],
        pre: false,
        safe: false,
        unsafeReason: "not text",
        text: "",
        hasLetters: false,
      });
      return;
    }

    const ctx: Ctx = {
      listDepth: parent.listDepth + (tag === "ul" || tag === "ol" || tag === "dl" ? 1 : 0),
      quoteDepth: parent.quoteDepth + (tag === "blockquote" ? 1 : 0),
      inFootnote: parent.inFootnote || types.some((t) => NOTE_TYPES.includes(t)),
      pre: parent.pre || styleIsPre(el, options.preClasses),
      ...containerRunRole(tag, parent),
    };

    if (cls === "atomic") {
      recordIds(el);
      return;
    }
    if (hasBlockDescendant(el) || (cls === "block" && isContainerOnly(tag))) {
      visitContainer(el, ctx);
    } else {
      emitElement(el, ctx);
    }
    // Ids inside are recorded by unit collection; also record any nested ones for mapping.
    for (const child of el.children) recordIds(child);
  }

  const rootCtx: Ctx = {
    listDepth: 0,
    quoteDepth: 0,
    inFootnote: false,
    pre: false,
    runRole: null,
    runHeadingLevel: 0,
  };
  const root = dom.children.find((c) => isElement(c) && localName(c) === "html");
  if (root && isElement(root)) {
    visitBlock(root, rootCtx);
  } else {
    // Fragment without <html>: treat the document itself as a container.
    let run: AnyNode[] = [];
    const ctx = rootCtx;
    for (const child of dom.children) {
      if (isBlockLike(child)) {
        emitRun(run, ctx);
        run = [];
        visitBlock(child, ctx);
      } else if (child.type !== "directive") {
        run.push(child);
      }
    }
    emitRun(run, ctx);
  }

  units.sort((a, b) => a.start - b.start);
  units.forEach((u, i) => {
    u.index = i;
  });

  const idToUnit = new Map<string, number>();
  for (const unit of units)
    for (const id of unit.ids) if (!idToUnit.has(id)) idToUnit.set(id, unit.index);
  for (const { id, pos } of idPositions) {
    if (idToUnit.has(id)) continue;
    idToUnit.set(id, unitAtOrAfter(units, pos));
  }

  return { src, dom, units, idToUnit, hasBody };
}

/** Block elements that only structure content (their direct text is ignored when empty). */
function isContainerOnly(tag: string): boolean {
  return (
    tag === "html" ||
    tag === "body" ||
    tag === "table" ||
    tag === "thead" ||
    tag === "tbody" ||
    tag === "tfoot" ||
    tag === "tr" ||
    tag === "ul" ||
    tag === "ol" ||
    tag === "dl" ||
    tag === "colgroup" ||
    tag === "menu"
  );
}

/** Index of the unit containing `pos`, or the first unit starting after it (units.length if none). */
export function unitAtOrAfter(units: FlowUnit[], pos: number): number {
  let lo = 0;
  let hi = units.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const u = units[mid]!;
    const end = u.elEnd ?? u.end;
    if (end <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Text of a list of units, joined with newlines. */
export function unitsText(units: FlowUnit[]): string {
  return units
    .filter((u) => u.kind !== "break" && u.role !== "title")
    .map((u) => u.text)
    .join("\n");
}

export { decodeText };
