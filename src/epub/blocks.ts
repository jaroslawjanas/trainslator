import { createHash } from "node:crypto";
import type { AnyNode, Element } from "domhandler";
import type { Placeholder, TransUnit } from "../shared/schemas/translation.ts";
import type { EpubBook } from "./book.ts";
import type { FlowUnit } from "./flow.ts";
import { looksLikeFileName } from "./text.ts";
import {
  classify,
  collapseSpaces,
  decodeText,
  elementRanges,
  findAll,
  getAttr,
  getAttrLocal,
  isElement,
  localName,
  parseOpenTag,
  removeSoftHyphens,
  semanticTypes,
  textContent,
} from "./xhtml.ts";

/**
 * Phase 3 translation units. Each unit's content becomes text with numbered
 * placeholders for inline markup:
 *   <gN>…</gN>  an inline element with text (italics, links, spans …)
 *   <xN/>       an element kept as-is (line break, image, footnote reference …)
 * Placeholders map back to the exact original tag text when splicing.
 */

export const EXTRACTOR_VERSION = 1;

export type { Placeholder, TransUnit };

export interface ExtractOptions {
  /** Disable normalizations (wrapper moves, merges, drop caps); used by identity tests. */
  normalize?: boolean;
}

// ---------------------------------------------------------------------------
// Intermediate representation
// ---------------------------------------------------------------------------

type IR =
  | { t: "text"; text: string }
  | {
      t: "g";
      name: string;
      open: string;
      close: string;
      required: boolean;
      presentational: boolean;
      children: IR[];
    }
  | { t: "x"; raw: string; label: string; movable: boolean; newline: boolean; alt: string | null };

const PAGEBREAK = ["pagebreak", "doc-pagebreak"];
const NOTEREF = ["noteref", "doc-noteref", "doc-biblioref", "doc-glossref"];
const NOTE_LABEL = /^[\s[(]*[\d*†‡§¶#a-z]{1,4}[\])\s]*$/i;
const SPAN_LIKE = new Set(["span", "font"]);

function isKoboSpan(el: Element): boolean {
  const cls = getAttr(el, "class") ?? "";
  const id = getAttr(el, "id") ?? "";
  return localName(el) === "span" && (/\bkoboSpan\b/.test(cls) || /^kobo\./.test(id));
}

function hasAnchorAttrs(el: Element): boolean {
  return (
    getAttr(el, "id") !== undefined ||
    getAttr(el, "xml:id") !== undefined ||
    getAttr(el, "href") !== undefined ||
    getAttr(el, "name") !== undefined ||
    getAttrLocal(el, "type") !== undefined ||
    getAttr(el, "role") !== undefined
  );
}

function isNoteRef(el: Element, text: string): boolean {
  const types = semanticTypes(el);
  if (types.some((t) => NOTEREF.includes(t))) return true;
  const name = localName(el);
  if (name === "a" && getAttr(el, "href") && NOTE_LABEL.test(text) && text.trim().length > 0) {
    return /^[\s[(]*[\d*†‡§¶#]/.test(text) || text.trim().length <= 2;
  }
  if (name === "sup" && text.trim().length <= 4) {
    const children = el.children.filter((c) => !(c.type === "text" && !c.data.trim()));
    const only = children[0];
    if (
      children.length === 1 &&
      only &&
      isElement(only) &&
      localName(only) === "a" &&
      getAttr(only, "href")
    ) {
      return true;
    }
  }
  return false;
}

function buildIR(src: string, nodes: AnyNode[], pre: boolean, notes: Set<string>): IR[] {
  const out: IR[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    if (pre && text.includes("\n")) {
      const parts = text.split("\n");
      parts.forEach((part, i) => {
        if (i > 0)
          out.push({
            t: "x",
            raw: "\n",
            label: "newline",
            movable: false,
            newline: true,
            alt: null,
          });
        if (part) out.push({ t: "text", text: part });
      });
      return;
    }
    out.push({ t: "text", text });
  };

  for (const node of nodes) {
    if (node.type === "text") {
      const decoded = decodeText(node.data);
      const cleaned = removeSoftHyphens(decoded);
      if (cleaned !== decoded) notes.add("soft hyphens removed");
      pushText(cleaned);
      continue;
    }
    if (node.type === "cdata") {
      pushText(textContent(node));
      continue;
    }
    if (node.type === "comment" || node.type === "directive") {
      notes.add("comments removed");
      continue;
    }
    if (!isElement(node)) continue;
    const ranges = elementRanges(src, node);
    if (!ranges) continue; // unit safety is checked earlier; never happens for safe units
    const name = localName(node);
    const raw = src.slice(ranges.start, ranges.end);
    const open = src.slice(ranges.start, ranges.openEnd);
    const close = ranges.selfClosing ? "" : src.slice(ranges.innerEnd, ranges.end);
    const cls = classify(node);

    if (name === "wbr") {
      notes.add("<wbr> removed");
      continue;
    }
    if (isKoboSpan(node)) {
      notes.add("Kobo spans removed");
      out.push(...buildIR(src, node.children, pre, notes));
      continue;
    }
    const text = textContent(node);
    const types = semanticTypes(node);
    if (name === "img" || name === "image") {
      const altRaw = getAttr(node, "alt");
      const alt = altRaw === undefined ? null : decodeText(altRaw).trim();
      out.push({
        t: "x",
        raw,
        label: name,
        movable: false,
        newline: false,
        alt: alt && !looksLikeFileName(alt) ? alt : null,
      });
      continue;
    }
    if (name === "br" || cls === "atomic" || cls === "skip") {
      out.push({ t: "x", raw, label: name, movable: false, newline: false, alt: null });
      continue;
    }
    if (types.some((t) => PAGEBREAK.includes(t))) {
      out.push({ t: "x", raw, label: "page break", movable: true, newline: false, alt: null });
      continue;
    }
    if (isNoteRef(node, text)) {
      out.push({ t: "x", raw, label: "note reference", movable: false, newline: false, alt: null });
      continue;
    }
    const hasImage =
      findAll(node, (el) => localName(el) === "img" || localName(el) === "image").length > 0;
    if (!text.trim() || (hasImage && !/\p{L}/u.test(text))) {
      // Empty anchors and other text-less elements are kept exactly.
      out.push({
        t: "x",
        raw,
        label: name,
        movable: !hasImage && !text.trim(),
        newline: false,
        alt: null,
      });
      continue;
    }
    const required = hasAnchorAttrs(node);
    out.push({
      t: "g",
      name,
      open,
      close,
      required,
      presentational: !required && SPAN_LIKE.has(name),
      children: buildIR(src, node.children, pre, notes),
    });
  }
  return out;
}

function irText(items: IR[]): string {
  return items
    .map((i) => (i.t === "text" ? i.text : i.t === "g" ? irText(i.children) : ""))
    .join("");
}

const LETTER = /\p{L}/u;

function lastChar(items: IR[]): string {
  const t = irText(items);
  return t.slice(-1);
}
function firstChar(items: IR[]): string {
  return irText(items).slice(0, 1);
}

function wordInternal(a: IR, b: IR): boolean {
  return LETTER.test(lastChar([a])) && LETTER.test(firstChar([b]));
}

/** Merges strictly adjacent identical presentational elements split mid-word. */
function mergeIdentical(items: IR[], notes: Set<string>): IR[] {
  const out: IR[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (
      item.t === "g" &&
      prev?.t === "g" &&
      !item.required &&
      !prev.required &&
      prev.open === item.open &&
      prev.close === item.close &&
      wordInternal(prev, item)
    ) {
      prev.children = [...prev.children, ...item.children];
      notes.add("split spans merged");
      continue;
    }
    out.push(item.t === "g" ? { ...item, children: mergeIdentical(item.children, notes) } : item);
  }
  return out;
}

/** Unwraps presentational spans at boundaries inside a word, so the AI sees whole words. */
function unwrapSplitWords(items: IR[], notes: Set<string>): IR[] {
  let changed = true;
  let list = items.map((i) =>
    i.t === "g" ? { ...i, children: unwrapSplitWords(i.children, notes) } : i,
  );
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]!;
      const b = list[i + 1]!;
      if (a.t === "x" || b.t === "x" || !wordInternal(a, b)) continue;
      const target =
        a.t === "g" && a.presentational ? i : b.t === "g" && b.presentational ? i + 1 : -1;
      if (target < 0) continue;
      const g = list[target] as Extract<IR, { t: "g" }>;
      list = [...list.slice(0, target), ...g.children, ...list.slice(target + 1)];
      notes.add("spans inside words unwrapped");
      changed = true;
      break;
    }
  }
  // Join adjacent text items.
  const joined: IR[] = [];
  for (const item of list) {
    const prev = joined[joined.length - 1];
    if (item.t === "text" && prev?.t === "text") prev.text += item.text;
    else joined.push(item);
  }
  return joined;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isSingleLetterGrapheme(text: string): boolean {
  const core = text.replace(/^\p{P}+/u, "");
  const parts = [...graphemes.segment(core)];
  return parts.length === 1 && LETTER.test(core);
}

/** Opening/closing tags of a chain of single-child g elements down to a text. */
function dropCapTags(
  g: Extract<IR, { t: "g" }>,
): { open: string; close: string; text: string } | null {
  if (g.children.length === 1 && g.children[0]!.t === "text") {
    return { open: g.open, close: g.close, text: g.children[0]!.text };
  }
  if (g.children.length === 1 && g.children[0]!.t === "g") {
    const inner = dropCapTags(g.children[0] as Extract<IR, { t: "g" }>);
    return inner
      ? { open: g.open + inner.open, close: inner.close + g.close, text: inner.text }
      : null;
  }
  return null;
}

function firstSignificant(items: IR[]): number {
  return items.findIndex((i) => !(i.t === "text" && !i.text.trim()));
}

export function extractUnit(
  src: string,
  unit: FlowUnit,
  docIndex: number,
  file: string,
  options: ExtractOptions = {},
): TransUnit {
  const normalize = options.normalize !== false;
  const notes = new Set<string>();
  const base: TransUnit = {
    key: "",
    file,
    docIndex,
    index: unit.index,
    kind: "text",
    role: unit.role,
    headingLevel: unit.headingLevel,
    inFootnote: unit.inFootnote,
    text: "",
    translate: false,
    skipReason: null,
    placeholders: [],
    prefix: "",
    suffix: "",
    dropCap: null,
    pre: unit.pre,
    start: unit.start,
    end: unit.end,
    quote: null,
    owner: null,
    notes: [],
  };
  if (!unit.safe) {
    return { ...base, text: unit.text, skipReason: unit.unsafeReason ?? "unsafe markup" };
  }

  let ir = buildIR(src, unit.nodes, unit.pre, notes);
  let prefix = "";
  let suffix = "";
  let dropCap: TransUnit["dropCap"] = null;

  // Leading/trailing whitespace stays outside the unit.
  const trimEnds = () => {
    while (ir.length > 0 && ir[0]!.t === "text") {
      const first = ir[0] as { t: "text"; text: string };
      const lead = /^[ \t\r\n]*/.exec(first.text)![0];
      prefix += lead;
      first.text = first.text.slice(lead.length);
      if (first.text) break;
      ir.shift();
    }
    while (ir.length > 0 && ir[ir.length - 1]!.t === "text") {
      const last = ir[ir.length - 1] as { t: "text"; text: string };
      const trail = /[ \t\r\n]*$/.exec(last.text)![0];
      suffix = trail + suffix;
      last.text = last.text.slice(0, last.text.length - trail.length);
      if (last.text) break;
      ir.pop();
    }
  };

  if (normalize) ir = mergeIdentical(ir, notes);
  trimEnds();

  if (normalize) {
    for (let guard = 0; guard < 20; guard++) {
      const first = ir[0];
      const last = ir[ir.length - 1];
      if (first?.t === "x" && first.movable) {
        prefix += first.raw;
        ir.shift();
        notes.add("anchors moved outside");
        trimEnds();
        continue;
      }
      if (last?.t === "x" && last.movable && ir.length > 1) {
        suffix = last.raw + suffix;
        ir.pop();
        notes.add("anchors moved outside");
        trimEnds();
        continue;
      }
      if (ir.length === 1 && first?.t === "g" && !first.required) {
        prefix += first.open;
        suffix = first.close + suffix;
        ir = first.children;
        notes.add("wrapper moved outside");
        trimEnds();
        continue;
      }
      break;
    }

    // Drop caps: a presentational first element holding one letter that starts a word.
    const i = firstSignificant(ir);
    const head = i >= 0 ? ir[i] : undefined;
    if (i === 0 && head?.t === "g" && !head.required) {
      const tags = dropCapTags(head);
      const rest = ir.slice(1);
      if (tags && isSingleLetterGrapheme(tags.text) && irText(rest).trim()) {
        dropCap = { open: tags.open, close: tags.close };
        ir = [{ t: "text", text: tags.text }, ...rest];
        notes.add("drop cap");
      }
    } else if (
      i === 0 &&
      head?.t === "x" &&
      head.label === "img" &&
      head.alt &&
      /^\p{L}$/u.test(head.alt)
    ) {
      const next = ir[1];
      if (next?.t === "text" && LETTER.test(next.text.slice(0, 1))) {
        ir = [{ t: "text", text: head.alt + next.text }, ...ir.slice(2)];
        notes.add("image drop cap replaced by its letter");
      }
    }

    // Only after drop caps are handled: unwrap spans that split words.
    ir = unwrapSplitWords(ir, notes);
  }

  // Serialize.
  const placeholders: Placeholder[] = [];
  let n = 0;
  const serialize = (items: IR[]): string =>
    items
      .map((item) => {
        if (item.t === "text") return unit.pre ? item.text : collapseSpaces(item.text);
        n++;
        if (item.t === "x") {
          placeholders.push({
            n,
            kind: "x",
            required: true,
            open: item.raw,
            close: null,
            label: item.label,
            newline: item.newline,
            hasAlt: item.alt !== null,
          });
          return `<x${n}/>`;
        }
        const id = n;
        placeholders.push({
          n: id,
          kind: "g",
          required: item.required,
          open: item.open,
          close: item.close,
          label: item.name,
          newline: false,
          hasAlt: false,
        });
        return `<g${id}>${serialize(item.children)}</g${id}>`;
      })
      .join("");
  const text = serialize(ir);
  const plain = text.replace(/<\/?g\d+>|<x\d+\/>/g, "");
  const translate = LETTER.test(plain);
  return {
    ...base,
    text,
    translate,
    skipReason: translate ? null : "no letters",
    placeholders,
    prefix,
    suffix,
    dropCap,
    notes: [...notes],
  };
}

function hashText(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

/** Alt texts of images inside a text unit become their own small units. */
function altUnitsFor(owner: TransUnit, unit: FlowUnit, src: string): TransUnit[] {
  if (!owner.translate) return [];
  const out: TransUnit[] = [];
  for (const p of owner.placeholders) {
    if (!p.hasAlt) continue;
    const parsed = parseOpenTag(p.open);
    const alt = parsed.attrs.find((a) => a.name.toLowerCase() === "alt");
    if (!alt) continue;
    const text = decodeText(alt.value).trim();
    out.push({
      ...owner,
      key: "",
      index: -1,
      kind: "alt",
      role: "alt",
      text,
      translate: LETTER.test(text),
      skipReason: LETTER.test(text) ? null : "no letters",
      placeholders: [],
      prefix: "",
      suffix: "",
      dropCap: null,
      quote: alt.quote,
      owner: { unitIndex: unit.index, n: p.n },
      notes: [],
    });
  }
  void src;
  return out;
}

/** Standalone alt units for images that aren't inside any text unit. */
function standaloneAltUnits(
  src: string,
  file: string,
  docIndex: number,
  root: AnyNode,
  covered: [number, number][],
): TransUnit[] {
  const out: TransUnit[] = [];
  for (const img of findAll(root, (el) => localName(el) === "img")) {
    const start = img.startIndex;
    if (start === null) continue;
    if (covered.some(([s, e]) => start >= s && start < e)) continue;
    const ranges = elementRanges(src, img);
    if (!ranges) continue;
    const tag = src.slice(ranges.start, ranges.openEnd);
    const parsed = parseOpenTag(tag);
    const alt = parsed.attrs.find((a) => a.name.toLowerCase() === "alt");
    if (!alt?.quote) continue;
    const text = decodeText(alt.value).trim();
    if (!text || looksLikeFileName(text) || !LETTER.test(text)) continue;
    out.push({
      key: "",
      file,
      docIndex,
      index: -1,
      kind: "alt",
      role: "alt",
      headingLevel: 0,
      inFootnote: false,
      text,
      translate: true,
      skipReason: null,
      placeholders: [],
      prefix: "",
      suffix: "",
      dropCap: null,
      pre: false,
      start: ranges.start + alt.valueStart,
      end: ranges.start + alt.valueEnd,
      quote: alt.quote,
      owner: null,
      notes: [],
    });
  }
  return out;
}

/** Assigns stable keys: file + hash of the text + occurrence number. */
export function assignKeys(units: TransUnit[]): TransUnit[] {
  const seen = new Map<string, number>();
  return units.map((u) => {
    const h = hashText(`${u.kind}\u0000${u.text}`);
    const base = `${u.docIndex}.${h}`;
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    return { ...u, key: `${base}.${occ}` };
  });
}

/** All translation units of one XHTML document (text units first in order, alt units after their owners). */
export function extractDocUnits(
  book: EpubBook,
  docIndex: number,
  options: ExtractOptions = {},
): TransUnit[] {
  const loaded = book.doc(docIndex);
  const units: TransUnit[] = [];
  const covered: [number, number][] = [];
  for (const flowUnit of loaded.flow.units) {
    if (flowUnit.kind === "break") continue;
    const unit = extractUnit(loaded.src, flowUnit, docIndex, loaded.info.path, options);
    units.push(unit);
    covered.push([flowUnit.start, flowUnit.end]);
    units.push(...altUnitsFor(unit, flowUnit, loaded.src));
  }
  units.push(...standaloneAltUnits(loaded.src, loaded.info.path, docIndex, loaded.dom, covered));
  return assignKeys(units);
}

/** Plain text of a unit without placeholders (for display, checks and counting). */
export function stripPlaceholders(text: string): string {
  return text.replace(/<\/?g\d+>|<x\d+\/>/g, "");
}
