import type { Element } from "domhandler";
import { primarySubtag } from "../shared/languages.ts";
import { assignKeys, extractUnit, type TransUnit } from "./blocks.ts";
import { EpubBook, strictXmlProblems } from "./book.ts";
import { checkSafe, type FlowUnit, plainText } from "./flow.ts";
import { newBookIdentifier, reobfuscate } from "./identity.ts";
import {
  altEdit,
  applyEdits,
  type Edit,
  type LangRewrite,
  renderTranslatedUnit,
  rewriteLangInMarkup,
} from "./splice.ts";
import {
  declareUtf8,
  decodeXmlBytes,
  elementRanges,
  escapeText,
  findAll,
  findFirst,
  getAttr,
  isElement,
  localName,
  parseXml,
  rewriteOpenTag,
  semanticTypes,
  textContent,
} from "./xhtml.ts";
import { writeEpubZip } from "./zip.ts";

const NAV_TYPES = ["toc", "landmarks", "page-list", "doc-toc", "doc-pagelist"];
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// TOC label units (nav document + NCX)
// ---------------------------------------------------------------------------

function pseudoUnit(src: string, el: Element, index: number): FlowUnit | null {
  const ranges = elementRanges(src, el);
  if (!ranges || ranges.selfClosing) return null;
  const text = plainText(el.children, false);
  const unsafe = checkSafe(src, el.children);
  return {
    index,
    kind: "element",
    tag: localName(el),
    role: "paragraph",
    headingLevel: 0,
    listDepth: 0,
    quoteDepth: 0,
    inFootnote: false,
    start: ranges.innerStart,
    end: ranges.innerEnd,
    elStart: ranges.start,
    elEnd: ranges.end,
    element: el,
    nodes: el.children,
    ids: [],
    pre: false,
    safe: unsafe === null,
    unsafeReason: unsafe,
    text,
    hasLetters: /\p{L}/u.test(text),
  };
}

/** Translatable labels of the navigation document (toc, landmarks, page-list) and the NCX. */
export function extractTocUnits(book: EpubBook): TransUnit[] {
  const units: TransUnit[] = [];
  const navDoc = book.docs.find((d) => d.isNav);
  if (navDoc) {
    const loaded = book.doc(navDoc.index);
    const navs = findAll(
      loaded.dom,
      (el) => localName(el) === "nav" && semanticTypes(el).some((t) => NAV_TYPES.includes(t)),
    );
    for (const nav of navs) {
      const labels = findAll(nav, (el) => {
        const name = localName(el);
        if (/^h[1-6]$/.test(name)) return true;
        if (name !== "a" && name !== "span") return false;
        const parent = el.parent;
        return (
          parent !== null && isElement(parent as never) && localName(parent as Element) === "li"
        );
      });
      for (const el of labels) {
        const unit = pseudoUnit(loaded.src, el, -1);
        if (!unit || !/\S/.test(unit.text)) continue;
        units.push({
          ...extractUnit(loaded.src, unit, navDoc.index, navDoc.path),
          kind: "toc",
          role: "toc",
          index: -1,
        });
      }
    }
  }
  const ncxPath = book.pkg.ncxPath;
  if (ncxPath && book.entryMap.has(ncxPath)) {
    const src = book.textOf(ncxPath);
    const dom = parseXml(src);
    const texts = findAll(dom, (el) => {
      if (localName(el) !== "text") return false;
      const parent = el.parent as Element | null;
      if (!parent || !isElement(parent as never)) return false;
      const p = localName(parent);
      return p === "navlabel" || p === "doctitle";
    });
    for (const el of texts) {
      const unit = pseudoUnit(src, el, -1);
      if (!unit || !/\S/.test(unit.text)) continue;
      units.push({ ...extractUnit(src, unit, -1, ncxPath), kind: "toc", role: "toc", index: -1 });
    }
  }
  return assignKeys(units);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildInput {
  book: EpubBook;
  sourceLang: string;
  targetLang: string;
  direction: "ltr" | "rtl";
  /** Text and alt units per document (only documents to translate). */
  unitsByDoc: Map<number, TransUnit[]>;
  tocUnits: TransUnit[];
  /** Final translated text (placeholder form) per unit key. Missing = keep the source. */
  translations: Map<string, string>;
  keepDocs: Set<number>;
  /** Translated main title, or null to keep it. */
  title: string | null;
  newIdentifier: boolean;
  removeEmbeddedFonts: boolean;
  /** Fixed timestamp for tests; defaults to now. */
  now?: Date;
}

export interface BuildReport {
  changedFiles: string[];
  removedFiles: string[];
  /** Strict-XML problems that weren't in the source file. */
  newXmlProblems: { file: string; problems: string[] }[];
  warnings: string[];
  /** Letters used in the translation that never appear in the source (embedded fonts may lack them). */
  missingGlyphs: string[];
  identifier: { old: string; new: string } | null;
  untranslatedUnits: number;
}

export interface BuildResult {
  bytes: Uint8Array;
  report: BuildReport;
}

function isEpub3(book: EpubBook): boolean {
  return book.pkg.version.trim().startsWith("3");
}

function modifiedTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Removes an element plus the whitespace before it on the same line. */
function removalEdit(src: string, el: Element): Edit | null {
  const r = elementRanges(src, el);
  if (!r) return null;
  let start = r.start;
  while (start > 0 && /[ \t]/.test(src[start - 1]!)) start--;
  if (start > 0 && src[start - 1] === "\n") start--;
  return { start, end: r.end, text: "" };
}

function openTagEdit(
  src: string,
  el: Element,
  changes: Parameters<typeof rewriteOpenTag>[1],
): Edit | null {
  const r = elementRanges(src, el);
  if (!r) return null;
  const tag = src.slice(r.start, r.openEnd);
  const next = rewriteOpenTag(tag, changes);
  return next === tag ? null : { start: r.start, end: r.openEnd, text: next };
}

function innerTextEdit(src: string, el: Element, text: string): Edit | null {
  const r = elementRanges(src, el);
  if (!r || r.selfClosing) return null;
  return { start: r.innerStart, end: r.innerEnd, text: escapeText(text) };
}

function normalizeProblem(p: string): string {
  return p.replace(/^[^:]*?\d+:\d+:\s*/, "").trim();
}

function newProblems(before: string, after: string): string[] {
  const old = new Set(strictXmlProblems(before, 50).map(normalizeProblem));
  return strictXmlProblems(after, 50)
    .map(normalizeProblem)
    .filter((p) => !old.has(p))
    .slice(0, 5);
}

const FONT_TYPES = /^(font\/|application\/(font-|x-font-|vnd\.ms-opentype))/;

export function buildTranslatedEpub(input: BuildInput): BuildResult {
  const { book } = input;
  const lang: LangRewrite = { sourceLang: input.sourceLang, targetLang: input.targetLang };
  const source = primarySubtag(input.sourceLang);
  const epub3 = isEpub3(book);
  const changed = new Map<string, Uint8Array>();
  const changedText = new Map<string, { before: string; after: string }>();
  const removed = new Set<string>();
  const warnings: string[] = [];
  let untranslated = 0;

  // --- Identifier and fonts ------------------------------------------------
  const oldIdentifier = book.pkg.identifier;
  let identifier: BuildReport["identifier"] = null;
  const fontsToRemove = new Set<string>();
  if (input.removeEmbeddedFonts) {
    for (const m of book.pkg.manifest) if (FONT_TYPES.test(m.mediaType)) fontsToRemove.add(m.path);
  }
  if (input.newIdentifier && oldIdentifier) {
    const next = newBookIdentifier();
    const reobfuscated = new Map<string, Uint8Array>();
    let ok = true;
    for (const font of book.encryption.obfuscatedFonts) {
      if (fontsToRemove.has(font.path)) continue;
      const entry = book.entryMap.get(font.path);
      if (!entry) continue;
      const data = reobfuscate(entry.data, font.algorithm, oldIdentifier, next);
      if (!data) {
        ok = false;
        break;
      }
      reobfuscated.set(font.path, data);
    }
    if (ok) {
      identifier = { old: oldIdentifier, new: next };
      for (const [p, data] of reobfuscated) changed.set(p, data);
    } else {
      warnings.push(
        "Kept the original book identifier: its embedded fonts can't be re-obfuscated for a new one.",
      );
    }
  }

  // --- XHTML documents -----------------------------------------------------
  const tocByFile = new Map<string, TransUnit[]>();
  for (const u of input.tocUnits) {
    const list = tocByFile.get(u.file) ?? [];
    list.push(u);
    tocByFile.set(u.file, list);
  }

  for (const doc of book.docs) {
    if (input.keepDocs.has(doc.index)) continue;
    const units = input.unitsByDoc.get(doc.index) ?? [];
    const tocUnits = tocByFile.get(doc.path) ?? [];
    const loaded = book.doc(doc.index);
    const src = loaded.src;
    const edits: Edit[] = [];
    const edited: [number, number][] = [];
    const frozen: [number, number][] = [];

    const altsByOwner = new Map<number, Map<number, string>>();
    for (const u of units) {
      if (u.kind !== "alt" || !u.owner) continue;
      const t = input.translations.get(u.key);
      if (t === undefined || !u.translate) continue;
      const m = altsByOwner.get(u.owner.unitIndex) ?? new Map<number, string>();
      m.set(u.owner.n, t);
      altsByOwner.set(u.owner.unitIndex, m);
    }

    for (const u of [...units, ...tocUnits]) {
      if (u.kind === "alt") {
        if (u.owner) continue;
        const t = input.translations.get(u.key);
        if (u.translate && t !== undefined) edits.push(altEdit(u, t));
        continue;
      }
      const t = input.translations.get(u.key);
      if (!u.translate || t === undefined) {
        if (u.translate) untranslated++;
        if (/\p{L}/u.test(u.text)) {
          const flowUnit = u.index >= 0 ? loaded.flow.units[u.index] : undefined;
          frozen.push([flowUnit?.elStart ?? u.start, flowUnit?.elEnd ?? u.end]);
        }
        continue;
      }
      const alts = u.index >= 0 ? altsByOwner.get(u.index) : undefined;
      edits.push({ start: u.start, end: u.end, text: renderTranslatedUnit(u, t, { lang, alts }) });
      edited.push([u.start, u.end]);
    }
    if (edits.length === 0) continue;

    // Language attributes on elements outside translated content.
    const inside = (pos: number, ranges: [number, number][]) =>
      ranges.some(([s, e]) => pos >= s && pos < e);
    const html = findFirst(loaded.dom, (el) => localName(el) === "html");
    for (const el of findAll(loaded.dom, () => true)) {
      if (el === html) continue;
      const start = el.startIndex;
      if (start === null || inside(start, edited) || inside(start, frozen)) continue;
      const langValue = getAttr(el, "lang") ?? getAttr(el, "xml:lang");
      if (langValue === undefined) continue;
      const edit = openTagEdit(src, el, {
        rewrite: (name, value) =>
          (name.toLowerCase() === "lang" || name.toLowerCase() === "xml:lang") &&
          primarySubtag(value) === source
            ? input.targetLang
            : null,
      });
      if (edit) edits.push(edit);
    }
    if (html) {
      const set: Record<string, string> = { "xml:lang": input.targetLang };
      if (epub3 || getAttr(html, "lang") !== undefined) set.lang = input.targetLang;
      if (input.direction === "rtl") set.dir = "rtl";
      const edit = openTagEdit(src, html, { set });
      if (edit) edits.push(edit);
    }

    let out = applyEdits(src, edits);
    if (loaded.decoded.encoding !== "utf-8") out = declareUtf8(out);
    changed.set(doc.path, encoder.encode(out));
    changedText.set(doc.path, { before: src, after: out });
  }

  // --- NCX -----------------------------------------------------------------
  const ncxPath = book.pkg.ncxPath;
  if (ncxPath && book.entryMap.has(ncxPath)) {
    const decoded = decodeXmlBytes(book.entryMap.get(ncxPath)!.data);
    const src = decoded.text;
    const dom = parseXml(src);
    const edits: Edit[] = [];
    for (const u of tocByFile.get(ncxPath) ?? []) {
      const t = input.translations.get(u.key);
      if (u.translate && t !== undefined)
        edits.push({ start: u.start, end: u.end, text: renderTranslatedUnit(u, t, { lang }) });
    }
    const ncx = findFirst(dom, (el) => localName(el) === "ncx");
    if (ncx && getAttr(ncx, "xml:lang") !== undefined) {
      const e = openTagEdit(src, ncx, { set: { "xml:lang": input.targetLang } });
      if (e) edits.push(e);
    }
    if (identifier) {
      for (const meta of findAll(
        dom,
        (el) => localName(el) === "meta" && getAttr(el, "name") === "dtb:uid",
      )) {
        const e = openTagEdit(src, meta, { set: { content: identifier.new } });
        if (e) edits.push(e);
      }
    }
    if (edits.length > 0) {
      let out = applyEdits(src, edits);
      if (decoded.encoding !== "utf-8") out = declareUtf8(out);
      changed.set(ncxPath, encoder.encode(out));
      changedText.set(ncxPath, { before: src, after: out });
    }
  }

  // --- Removed files ---------------------------------------------------------
  if (book.entryMap.has("META-INF/signatures.xml")) removed.add("META-INF/signatures.xml");
  const smil = book.pkg.manifest.filter((m) => m.mediaType === "application/smil+xml");
  for (const m of smil) removed.add(m.path);
  for (const p of fontsToRemove) removed.add(p);

  // --- OPF -----------------------------------------------------------------
  {
    const opfPath = book.pkg.opfPath;
    const decoded = decodeXmlBytes(book.entryMap.get(opfPath)!.data);
    const src = decoded.text;
    const dom = parseXml(src);
    const edits: Edit[] = [];
    const pkg = findFirst(dom, (el) => localName(el) === "package");
    const metadata = pkg ? findFirst(pkg, (el) => localName(el) === "metadata") : null;
    if (pkg && metadata) {
      const dcName = (el: Element) => el.name.toLowerCase().startsWith("dc:");
      const metaChildren = metadata.children.filter((c): c is Element => isElement(c));

      // Languages
      let sawTarget = false;
      for (const el of metaChildren.filter((e) => dcName(e) && localName(e) === "language")) {
        const value = textContent(el).trim();
        const becomes = primarySubtag(value) === source ? input.targetLang : value;
        if (becomes === input.targetLang) {
          if (sawTarget) {
            const e = removalEdit(src, el);
            if (e) edits.push(e);
            continue;
          }
          sawTarget = true;
          if (becomes !== value) {
            const e = innerTextEdit(src, el, becomes);
            if (e) edits.push(e);
          }
        }
      }

      // Title
      const titles = metaChildren.filter((e) => dcName(e) && localName(e) === "title");
      const mainTitle = titles[0];
      if (mainTitle && input.title) {
        const e = innerTextEdit(src, mainTitle, input.title);
        if (e) edits.push(e);
        const tagEdit = openTagEdit(src, mainTitle, {
          set: { "xml:lang": input.targetLang },
          remove: ["opf:file-as"],
        });
        if (tagEdit) edits.push(tagEdit);
        const titleId = getAttr(mainTitle, "id");
        if (titleId) {
          for (const meta of metaChildren.filter((m) => localName(m) === "meta")) {
            const refines = getAttr(meta, "refines");
            const prop = getAttr(meta, "property") ?? "";
            if (refines === `#${titleId}` && (prop === "file-as" || prop === "alternate-script")) {
              const r = removalEdit(src, meta);
              if (r) edits.push(r);
            }
          }
        }
      }

      if (epub3) {
        if (getAttr(pkg, "xml:lang") !== undefined) {
          const e = openTagEdit(src, pkg, { set: { "xml:lang": input.targetLang } });
          if (e) edits.push(e);
        }
        const modified = metaChildren.filter(
          (m) => localName(m) === "meta" && getAttr(m, "property") === "dcterms:modified",
        );
        const stamp = modifiedTimestamp(input.now ?? new Date());
        if (modified[0]) {
          const e = innerTextEdit(src, modified[0], stamp);
          if (e) edits.push(e);
          for (const extra of modified.slice(1)) {
            const r = removalEdit(src, extra);
            if (r) edits.push(r);
          }
        } else {
          const r = elementRanges(src, metadata);
          if (r && !r.selfClosing) {
            edits.push({
              start: r.innerEnd,
              end: r.innerEnd,
              text: `  <meta property="dcterms:modified">${stamp}</meta>\n  `,
            });
          }
        }
      }

      if (identifier) {
        const ids = metaChildren.filter((e) => dcName(e) && localName(e) === "identifier");
        const uniqueId = getAttr(pkg, "unique-identifier");
        const main = ids.find((e) => uniqueId && getAttr(e, "id") === uniqueId) ?? ids[0];
        if (main) {
          const e = innerTextEdit(src, main, identifier.new);
          if (e) edits.push(e);
          const r = elementRanges(src, metadata);
          if (r && !r.selfClosing) {
            const prefix = main.name.slice(0, main.name.indexOf(":") + 1) || "dc:";
            edits.push({
              start: r.innerEnd,
              end: r.innerEnd,
              text: `  <${prefix}source>${escapeText(identifier.old)}</${prefix}source>\n  `,
            });
          }
        }
      }

      for (const meta of metaChildren.filter(
        (m) => localName(m) === "meta" && (getAttr(m, "property") ?? "").startsWith("media:"),
      )) {
        const r = removalEdit(src, meta);
        if (r) edits.push(r);
      }
    }

    const manifest = pkg ? findFirst(pkg, (el) => localName(el) === "manifest") : null;
    if (manifest) {
      for (const item of manifest.children.filter(
        (c): c is Element => isElement(c) && localName(c) === "item",
      )) {
        const mediaType = (getAttr(item, "media-type") ?? "").toLowerCase();
        const href = book.pkg.manifest.find((m) => m.id === getAttr(item, "id"))?.path;
        if (mediaType === "application/smil+xml" || (href && fontsToRemove.has(href))) {
          const r = removalEdit(src, item);
          if (r) edits.push(r);
          continue;
        }
        if (getAttr(item, "media-overlay") !== undefined) {
          const e = openTagEdit(src, item, { remove: ["media-overlay"] });
          if (e) edits.push(e);
        }
      }
    }

    const spine = pkg ? findFirst(pkg, (el) => localName(el) === "spine") : null;
    if (spine && epub3 && input.direction === "rtl") {
      const e = openTagEdit(src, spine, { set: { "page-progression-direction": "rtl" } });
      if (e) edits.push(e);
    }

    let out = applyEdits(src, edits);
    if (decoded.encoding !== "utf-8") out = declareUtf8(out);
    changed.set(opfPath, encoder.encode(out));
    changedText.set(opfPath, { before: src, after: out });
  }

  // --- Embedded fonts: CSS and encryption.xml -----------------------------
  if (fontsToRemove.size > 0) {
    for (const m of book.pkg.manifest.filter((x) => x.mediaType === "text/css")) {
      const entry = book.entryMap.get(m.path);
      if (!entry) continue;
      const css = decodeXmlBytes(entry.data).text;
      const out = css.replace(/@font-face\s*\{[^}]*\}/gi, "");
      if (out !== css) changed.set(m.path, encoder.encode(out));
    }
    const enc = book.entryMap.get("META-INF/encryption.xml");
    if (enc) {
      const src = decodeXmlBytes(enc.data).text;
      const dom = parseXml(src);
      const edits: Edit[] = [];
      const datas = findAll(dom, (el) => localName(el) === "encrypteddata");
      for (const data of datas) {
        const ref = findFirst(data, (el) => localName(el) === "cipherreference");
        const uri = ref ? (getAttr(ref, "URI") ?? "") : "";
        let p = uri;
        try {
          p = decodeURIComponent(uri);
        } catch {
          // keep
        }
        if (fontsToRemove.has(p.replace(/^\/+/, ""))) {
          const r = removalEdit(src, data);
          if (r) edits.push(r);
        }
      }
      if (edits.length === datas.length && datas.length > 0) removed.add("META-INF/encryption.xml");
      else if (edits.length > 0)
        changed.set("META-INF/encryption.xml", encoder.encode(applyEdits(src, edits)));
    }
  }

  // --- Archive --------------------------------------------------------------
  const outEntries = book.entries
    .filter((e) => !removed.has(e.name))
    .map((e) => ({ name: e.name, data: changed.get(e.name) ?? e.data }));
  const bytes = writeEpubZip(outEntries);

  // --- Checks ---------------------------------------------------------------
  const newXmlProblems: BuildReport["newXmlProblems"] = [];
  for (const [file, { before, after }] of changedText) {
    const problems = newProblems(before, after);
    if (problems.length > 0) newXmlProblems.push({ file, problems });
  }
  EpubBook.open(bytes, { rejectFixedLayout: false });

  let missingGlyphs: string[] = [];
  const hasFonts =
    (book.css.hasFontFace || book.encryption.obfuscatedFonts.length > 0) &&
    fontsToRemove.size === 0;
  if (hasFonts) {
    const sourceChars = new Set<string>();
    for (const doc of book.docs)
      for (const u of book.doc(doc.index).flow.units) for (const ch of u.text) sourceChars.add(ch);
    const missing = new Set<string>();
    for (const t of input.translations.values()) {
      for (const ch of t.replace(/<\/?g\d+>|<x\d+\/>/g, "")) {
        if (/\p{L}/u.test(ch) && !sourceChars.has(ch)) missing.add(ch);
      }
    }
    missingGlyphs = [...missing].slice(0, 60);
  }

  return {
    bytes,
    report: {
      changedFiles: [...changed.keys()],
      removedFiles: [...removed],
      newXmlProblems,
      warnings,
      missingGlyphs,
      identifier,
      untranslatedUnits: untranslated,
    },
  };
}

/** Rewrites lang attributes in a raw markup string (re-exported for callers building TOC labels). */
export { rewriteLangInMarkup };
