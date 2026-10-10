import { decodeHTMLStrict } from "entities/decode";
import { primarySubtag } from "../shared/languages.ts";
import type { Placeholder, TransUnit } from "./blocks.ts";
import { escapeAttr, escapeText, openTagEnd, removeXmlIllegal, rewriteOpenTag } from "./xhtml.ts";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export class OverlapError extends Error {
  constructor(a: Edit, b: Edit) {
    super(`Overlapping edits [${a.start},${a.end}) and [${b.start},${b.end})`);
    this.name = "OverlapError";
  }
}

/** Applies non-overlapping edits. Throws if any two ranges overlap. */
export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start < prev.end) throw new OverlapError(prev, cur);
    if (cur.start === prev.start && cur.end === prev.end && cur.start === cur.end) {
      throw new OverlapError(prev, cur);
    }
  }
  let out = "";
  let pos = 0;
  for (const e of sorted) {
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos);
}

// ---------------------------------------------------------------------------
// Placeholder text
// ---------------------------------------------------------------------------

export type Token =
  | { t: "text"; text: string }
  | { t: "open"; n: number }
  | { t: "close"; n: number }
  | { t: "x"; n: number };

const TOKEN_RE = /<(\/?)g(\d+)>|<x(\d+)\s*\/>/g;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > pos) out.push({ t: "text", text: text.slice(pos, m.index) });
    if (m[3] !== undefined) out.push({ t: "x", n: Number(m[3]) });
    else out.push({ t: m[1] ? "close" : "open", n: Number(m[2]) });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push({ t: "text", text: text.slice(pos) });
  return out;
}

/** Cleans model text before escaping: entities it wrote, XML-illegal chars, NFC, newlines. */
export function cleanModelText(text: string, keepNewlines: boolean): string {
  let t = text.includes("&") ? decodeHTMLStrict(text) : text;
  t = removeXmlIllegal(t).normalize("NFC");
  if (!keepNewlines) t = t.replace(/\r?\n/g, " ");
  return t;
}

// ---------------------------------------------------------------------------
// Language attributes
// ---------------------------------------------------------------------------

export interface LangRewrite {
  sourceLang: string;
  targetLang: string;
}

/** Rewrites lang / xml:lang values in the source language, in every opening tag of a markup string. */
export function rewriteLangInMarkup(markup: string, lang: LangRewrite): string {
  if (!/\blang\s*=/i.test(markup)) return markup;
  const source = primarySubtag(lang.sourceLang);
  let out = "";
  let pos = 0;
  for (let i = markup.indexOf("<"); i >= 0; i = markup.indexOf("<", i + 1)) {
    const next = markup[i + 1];
    if (!next || next === "/" || next === "!" || next === "?") continue;
    const end = openTagEnd(markup, i);
    if (end < 0) break;
    const tag = markup.slice(i, end + 1);
    if (!/\blang\s*=/i.test(tag)) continue;
    const rewritten = rewriteOpenTag(tag, {
      rewrite: (name, value) => {
        const lower = name.toLowerCase();
        if ((lower === "lang" || lower === "xml:lang") && primarySubtag(value) === source)
          return lang.targetLang;
        return null;
      },
    });
    out += markup.slice(pos, i) + rewritten;
    pos = end + 1;
    i = end;
  }
  return out + markup.slice(pos);
}

// ---------------------------------------------------------------------------
// Rendering a translated unit
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface RenderOptions {
  lang: LangRewrite;
  /** Translated alt texts keyed by placeholder number (images inside this unit). */
  alts?: Map<number, string>;
}

function renderPlaceholderOpen(p: Placeholder, options: RenderOptions): string {
  if (p.kind === "x") {
    if (p.newline) return "\n";
    let raw = p.open;
    const alt = options.alts?.get(p.n);
    if (alt !== undefined) {
      const end = openTagEnd(raw, 0);
      if (end >= 0)
        raw = rewriteOpenTag(raw.slice(0, end + 1), { set: { alt } }) + raw.slice(end + 1);
    }
    return rewriteLangInMarkup(raw, options.lang);
  }
  return rewriteLangInMarkup(p.open, options.lang);
}

/**
 * Turns translated placeholder text into markup for the unit's range.
 * Unknown placeholders are dropped; validation should have caught them already.
 */
export function renderTranslatedUnit(
  unit: TransUnit,
  translated: string,
  options: RenderOptions,
): string {
  const byN = new Map(unit.placeholders.map((p) => [p.n, p]));
  const tokens = tokenize(translated);
  let body = "";
  let dropCapPending = unit.dropCap !== null;
  for (const token of tokens) {
    if (token.t === "text") {
      let text = cleanModelText(token.text, unit.pre);
      if (dropCapPending && unit.dropCap && text.trim()) {
        const lead = /^\s*/.exec(text)![0];
        const rest = text.slice(lead.length);
        const punct = /^\p{P}*/u.exec(rest)![0];
        const afterPunct = rest.slice(punct.length);
        const first = [...segmenter.segment(afterPunct)][0]?.segment ?? "";
        if (first && /\p{L}/u.test(first)) {
          body +=
            escapeText(lead) + unit.dropCap.open + escapeText(punct + first) + unit.dropCap.close;
          text = afterPunct.slice(first.length);
        }
        dropCapPending = false;
      }
      body += escapeText(text);
      continue;
    }
    const p = byN.get(token.n);
    if (!p) continue;
    if (token.t === "x") {
      if (p.kind === "x") body += renderPlaceholderOpen(p, options);
      dropCapPending = false;
    } else if (token.t === "open") {
      if (p.kind === "g") body += renderPlaceholderOpen(p, options);
      dropCapPending = false;
    } else if (p.kind === "g") {
      body += p.close ?? "";
    }
  }
  return (
    rewriteLangInMarkup(unit.prefix, options.lang) +
    body +
    rewriteLangInMarkup(unit.suffix, options.lang)
  );
}

/** Edit for a standalone alt unit (attribute value inside an image tag). */
export function altEdit(unit: TransUnit, translated: string): Edit {
  const value = cleanModelText(translated, false).trim();
  return { start: unit.start, end: unit.end, text: escapeAttr(value, unit.quote ?? '"') };
}
