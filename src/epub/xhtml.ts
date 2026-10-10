import type { AnyNode, Document, Element } from "domhandler";
import { decodeHTMLStrict } from "entities/decode";
import { parseDocument } from "htmlparser2";

/**
 * XHTML helpers. Documents are parsed in XML mode with source positions so
 * that edits can replace exact ranges of the original text. All positions are
 * offsets into the decoded JS string (never byte offsets).
 *
 * htmlparser2 positions: `startIndex` is the first character of the node,
 * `endIndex` is the LAST character (inclusive). Unclosed elements are closed
 * implicitly and get the end position of whatever closed them, so every range
 * we rely on is verified (see `elementRanges`).
 */

export function parseXml(src: string): Document {
  return parseDocument(src, {
    xmlMode: true,
    withStartIndices: true,
    withEndIndices: true,
    decodeEntities: false,
  });
}

// ---------------------------------------------------------------------------
// Decoding bytes → string
// ---------------------------------------------------------------------------

export interface DecodedText {
  text: string;
  encoding: string;
  hadBom: boolean;
}

const latin1 = new TextDecoder("latin1");

function tryDecoder(label: string): InstanceType<typeof TextDecoder> | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

/** Decodes an XML/XHTML file: byte-order mark, then XML declaration, then <meta charset>, else UTF-8. */
export function decodeXmlBytes(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(3)),
      encoding: "utf-8",
      hadBom: true,
    };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder("utf-16be").decode(bytes.subarray(2)),
      encoding: "utf-16be",
      hadBom: true,
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder("utf-16le").decode(bytes.subarray(2)),
      encoding: "utf-16le",
      hadBom: true,
    };
  }
  const head = latin1.decode(bytes.subarray(0, 2048));
  const declared =
    /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    null;
  if (declared && !/^utf-?8$/i.test(declared)) {
    const decoder = tryDecoder(declared);
    if (decoder) return { text: decoder.decode(bytes), encoding: decoder.encoding, hadBom: false };
  }
  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8", hadBom: false };
}

/** Rewrites encoding declarations to UTF-8 (the output is always UTF-8). */
export function declareUtf8(src: string): string {
  return src
    .replace(/^(\s*<\?xml[^>]*\bencoding\s*=\s*)(["'])[^"']*\2/i, "$1$2UTF-8$2")
    .replace(/(<meta[^>]*\bcharset\s*=\s*)(["']?)[\w-]+\2/gi, "$1$2utf-8$2")
    .replace(/(<meta[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*)[\w-]+/gi, "$1utf-8");
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

export function isElement(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

/** Local name, lowercased: "m:math" → "math", "P" → "p". */
export function localName(el: Element): string {
  const name = el.name;
  const colon = name.indexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

/** Attribute value by name (case-insensitive). */
export function getAttr(el: Element, name: string): string | undefined {
  const direct = el.attribs[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(el.attribs)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Attribute by local name, ignoring any prefix: "epub:type", "type" with prefix, etc. */
export function getAttrLocal(el: Element, local: string): string | undefined {
  for (const [key, value] of Object.entries(el.attribs)) {
    const colon = key.indexOf(":");
    const name = colon >= 0 ? key.slice(colon + 1) : key;
    if (name.toLowerCase() === local) return value;
  }
  return undefined;
}

/** Decoded `epub:type` tokens plus `role` tokens. */
export function semanticTypes(el: Element): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(el.attribs)) {
    const k = key.toLowerCase();
    if (k === "epub:type" || k.endsWith(":type") || k === "role") {
      for (const token of decodeText(value).split(/\s+/)) if (token) out.push(token.toLowerCase());
    }
  }
  return out;
}

export function elementId(el: Element): string | undefined {
  const id = el.attribs.id ?? el.attribs["xml:id"];
  return id === undefined ? undefined : decodeText(id);
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/** Index of the `>` that ends the opening tag starting at `start`, skipping quoted values. */
export function openTagEnd(src: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

export interface ElementRanges {
  /** First character of the opening tag. */
  start: number;
  /** One past the opening tag's `>`. */
  openEnd: number;
  selfClosing: boolean;
  /** Content between the tags: [innerStart, innerEnd). Empty for self-closing elements. */
  innerStart: number;
  innerEnd: number;
  /** One past the closing tag's `>`. */
  end: number;
}

/**
 * Exact ranges of an element, or null when its tags can't be trusted
 * (implicitly closed, mismatched, or no position information).
 */
export function elementRanges(src: string, el: Element): ElementRanges | null {
  const start = el.startIndex;
  const last = el.endIndex;
  if (start === null || last === null) return null;
  if (src[start] !== "<") return null;
  const gt = openTagEnd(src, start);
  if (gt < 0 || gt > last) return null;
  const openEnd = gt + 1;
  const selfClosing = src[gt - 1] === "/";
  if (selfClosing) {
    if (last !== gt) return null;
    return { start, openEnd, selfClosing, innerStart: openEnd, innerEnd: openEnd, end: openEnd };
  }
  if (src[last] !== ">") return null;
  const closeStart = src.lastIndexOf("</", last);
  if (closeStart < openEnd) return null;
  const closeName = src.slice(closeStart + 2, last).trim();
  if (closeName !== el.name) return null;
  return { start, openEnd, selfClosing, innerStart: openEnd, innerEnd: closeStart, end: last + 1 };
}

/** Exact range of a non-element node: [start, end). */
export function nodeRange(node: AnyNode): [number, number] | null {
  if (node.startIndex === null || node.endIndex === null) return null;
  return [node.startIndex, node.endIndex + 1];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Strict entity decoding: `&copy2020` stays as written, `&nbsp;` becomes U+00A0. */
export function decodeText(raw: string): string {
  return raw.includes("&") ? decodeHTMLStrict(raw) : raw;
}

export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(text: string, quote: '"' | "'"): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return quote === '"' ? escaped.replace(/"/g, "&quot;") : escaped.replace(/'/g, "&apos;");
}

/** Collapses runs of space/tab/newline only. NBSP and other Unicode spaces are kept. */
export function collapseSpaces(text: string): string {
  return text.replace(/[ \t\r\n]+/g, " ");
}

const SOFT_HYPHEN = /\u00ad/g;
export function removeSoftHyphens(text: string): string {
  return text.replace(SOFT_HYPHEN, "");
}

/** Characters not allowed in XML 1.0, plus lone surrogates. */
export function removeXmlIllegal(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").toWellFormed();
}

/** Decoded text content of a subtree (CDATA included, comments and PIs skipped). */
export function textContent(node: AnyNode): string {
  if (node.type === "text") return decodeText(node.data);
  if (node.type === "cdata")
    return node.children.map((c) => (c.type === "text" ? c.data : "")).join("");
  if (isElement(node)) return node.children.map(textContent).join("");
  return "";
}

// ---------------------------------------------------------------------------
// Opening-tag rewriting
// ---------------------------------------------------------------------------

export interface TagAttr {
  name: string;
  /** Raw (still escaped) value. */
  value: string;
  quote: '"' | "'" | null;
  /** Range of the whole attribute (name=value) within the tag string. */
  start: number;
  end: number;
  /** Range of the value within the tag string (inside the quotes). */
  valueStart: number;
  valueEnd: number;
}

export interface ParsedTag {
  name: string;
  attrs: TagAttr[];
  selfClosing: boolean;
  /** Position where new attributes can be inserted (before `>` or `/>`). */
  insertAt: number;
}

/** Parses one opening tag string like `<p class="x" lang='en'>`. */
export function parseOpenTag(tag: string): ParsedTag {
  let i = 1;
  while (i < tag.length && !/[\s/>]/.test(tag[i]!)) i++;
  const name = tag.slice(1, i);
  const attrs: TagAttr[] = [];
  const end = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
  while (i < end) {
    while (i < end && /\s/.test(tag[i]!)) i++;
    if (i >= end) break;
    const attrStart = i;
    while (i < end && !/[\s=>/]/.test(tag[i]!)) i++;
    const attrName = tag.slice(attrStart, i);
    if (!attrName) {
      i++;
      continue;
    }
    while (i < end && /\s/.test(tag[i]!)) i++;
    if (tag[i] !== "=") {
      attrs.push({
        name: attrName,
        value: "",
        quote: null,
        start: attrStart,
        end: i,
        valueStart: i,
        valueEnd: i,
      });
      continue;
    }
    i++;
    while (i < end && /\s/.test(tag[i]!)) i++;
    const q = tag[i];
    if (q === '"' || q === "'") {
      const close = tag.indexOf(q, i + 1);
      const valueEnd = close < 0 ? end : close;
      attrs.push({
        name: attrName,
        value: tag.slice(i + 1, valueEnd),
        quote: q,
        start: attrStart,
        end: Math.min(valueEnd + 1, end),
        valueStart: i + 1,
        valueEnd,
      });
      i = valueEnd + 1;
    } else {
      const valueStart = i;
      while (i < end && !/[\s>]/.test(tag[i]!)) i++;
      attrs.push({
        name: attrName,
        value: tag.slice(valueStart, i),
        quote: null,
        start: attrStart,
        end: i,
        valueStart,
        valueEnd: i,
      });
    }
  }
  let insertAt = end;
  while (insertAt > 0 && /\s/.test(tag[insertAt - 1]!)) insertAt--;
  return { name, attrs, selfClosing: tag.endsWith("/>"), insertAt };
}

export interface TagChanges {
  /** Rewrites an existing attribute's decoded value; return null to keep it. */
  rewrite?: (name: string, value: string) => string | null;
  /** Sets attributes: replaces existing values (any case) or appends new ones. */
  set?: Record<string, string>;
  /** Removes attributes by exact name. */
  remove?: string[];
}

/** Applies attribute changes to an opening tag, leaving everything else untouched. */
export function rewriteOpenTag(tag: string, changes: TagChanges): string {
  const parsed = parseOpenTag(tag);
  const edits: { start: number; end: number; text: string }[] = [];
  const handled = new Set<string>();
  for (const attr of parsed.attrs) {
    const key = attr.name;
    if (changes.remove?.includes(key)) {
      // Remove the attribute plus the whitespace before it.
      let s = attr.start;
      while (s > 0 && /\s/.test(tag[s - 1]!)) s--;
      edits.push({ start: s, end: attr.end, text: "" });
      handled.add(key.toLowerCase());
      continue;
    }
    const setKey = changes.set
      ? Object.keys(changes.set).find((k) => k.toLowerCase() === key.toLowerCase())
      : undefined;
    let next: string | null = null;
    if (setKey !== undefined) {
      next = changes.set![setKey]!;
      handled.add(setKey.toLowerCase());
    } else if (changes.rewrite) {
      next = changes.rewrite(key, decodeText(attr.value));
    }
    if (next !== null) {
      const quote = attr.quote ?? '"';
      if (attr.quote) {
        edits.push({ start: attr.valueStart, end: attr.valueEnd, text: escapeAttr(next, quote) });
      } else {
        edits.push({ start: attr.start, end: attr.end, text: `${key}="${escapeAttr(next, '"')}"` });
      }
    }
  }
  let additions = "";
  for (const [key, value] of Object.entries(changes.set ?? {})) {
    if (!handled.has(key.toLowerCase())) additions += ` ${key}="${escapeAttr(value, '"')}"`;
  }
  if (additions) edits.push({ start: parsed.insertAt, end: parsed.insertAt, text: additions });
  edits.sort((a, b) => b.start - a.start);
  let out = tag;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "dt",
  "dd",
  "blockquote",
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "hgroup",
  "address",
  "center",
  "figure",
  "figcaption",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "pre",
  "ol",
  "ul",
  "dl",
  "details",
  "summary",
  "nav",
  "hr",
  "body",
  "html",
  "head",
  "title",
  "colgroup",
  "col",
  "menu",
  "fieldset",
  "legend",
  "form",
  "noscript",
]);

export const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "cite",
  "code",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "img",
  "ins",
  "kbd",
  "label",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
  "image",
]);

/** Kept untouched; become a single placeholder inside text. */
export const ATOMIC_TAGS = new Set([
  "svg",
  "math",
  "video",
  "audio",
  "object",
  "ruby",
  "switch",
  "iframe",
  "canvas",
  "embed",
  "input",
  "button",
  "select",
  "textarea",
  "map",
]);

/** Never translated, never part of text. */
export const SKIP_TAGS = new Set(["script", "style", "link", "meta", "base", "template"]);

export const VOID_TAGS = new Set([
  "br",
  "img",
  "wbr",
  "hr",
  "col",
  "embed",
  "input",
  "image",
  "area",
  "source",
  "track",
]);

export type ElementClass = "block" | "inline" | "atomic" | "skip";

export function classify(el: Element): ElementClass {
  const name = localName(el);
  if (SKIP_TAGS.has(name)) return "skip";
  if (ATOMIC_TAGS.has(name)) return "atomic";
  if (BLOCK_TAGS.has(name)) return "block";
  if (INLINE_TAGS.has(name)) return "inline";
  // Unknown elements: decided by their content (see hasBlockDescendant).
  return "inline";
}

const blockDescendantCache = new WeakMap<Element, boolean>();

/** True when the subtree contains a block element (atomic subtrees aren't looked into). */
export function hasBlockDescendant(el: Element): boolean {
  const cached = blockDescendantCache.get(el);
  if (cached !== undefined) return cached;
  let result = false;
  for (const child of el.children) {
    if (!isElement(child)) continue;
    const cls = classify(child);
    if (cls === "block" || (cls === "inline" && hasBlockDescendant(child))) {
      result = true;
      break;
    }
  }
  blockDescendantCache.set(el, result);
  return result;
}

/** Block-like = a block element, or an inline/unknown element that wraps blocks. */
export function isBlockLike(node: AnyNode): node is Element {
  if (!isElement(node)) return false;
  const cls = classify(node);
  if (cls === "block" || cls === "skip") return true;
  if (cls === "inline") return hasBlockDescendant(node);
  return false;
}

export function findFirst(node: AnyNode, pred: (el: Element) => boolean): Element | null {
  if (isElement(node) && pred(node)) return node;
  if ("children" in node) {
    for (const child of node.children) {
      const found = findFirst(child, pred);
      if (found) return found;
    }
  }
  return null;
}

export function findAll(
  node: AnyNode,
  pred: (el: Element) => boolean,
  out: Element[] = [],
): Element[] {
  if (isElement(node) && pred(node)) out.push(node);
  if ("children" in node) for (const child of node.children) findAll(child, pred, out);
  return out;
}
