import type { Document } from "domhandler";
import { decodeHTMLStrict } from "entities/decode";
import { SaxesParser } from "saxes";
import type { Diagnostic } from "../shared/schemas/common.ts";
import { buildFlow, type DocFlow } from "./flow.ts";
import { type CssInfo, type EncryptionInfo, inspectEncryption, scanCss } from "./inspect.ts";
import { findOpfPath, type PackageInfo, parsePackage, XHTML_TYPES } from "./package.ts";
import { chooseToc, parseNavToc, parseNcx, type TocEntry } from "./toc.ts";
import { type DecodedText, decodeXmlBytes, parseXml } from "./xhtml.ts";
import { DEFAULT_ZIP_LIMITS, readZip, type ZipEntry, type ZipLimits } from "./zip.ts";

export class EpubImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EpubImportError";
    this.code = code;
  }
}

export interface BookDoc {
  index: number;
  path: string;
  mediaType: string;
  manifestId: string;
  inSpine: boolean;
  /** Position in the spine, or null for documents outside it. */
  spinePos: number | null;
  linear: boolean;
  isNav: boolean;
}

export interface LoadedDoc {
  info: BookDoc;
  decoded: DecodedText;
  src: string;
  dom: Document;
  flow: DocFlow;
}

export interface OpenOptions {
  limits?: ZipLimits;
  /** Reject fixed-layout books (default true). */
  rejectFixedLayout?: boolean;
}

/** An opened EPUB: archive entries, package info, TOC and lazily parsed documents. */
export class EpubBook {
  readonly entries: ZipEntry[];
  readonly entryMap: Map<string, ZipEntry>;
  readonly pkg: PackageInfo;
  readonly encryption: EncryptionInfo;
  readonly css: CssInfo;
  readonly docs: BookDoc[];
  readonly toc: TocEntry[];
  readonly tocSource: "nav" | "ncx" | "none";
  readonly navToc: TocEntry[];
  readonly ncxToc: TocEntry[];
  private readonly loaded = new Map<number, LoadedDoc>();

  private constructor(entries: ZipEntry[], options: OpenOptions) {
    this.entries = entries;
    this.entryMap = new Map(entries.map((e) => [e.name, e]));
    this.encryption = inspectEncryption(entries);
    if (this.encryption.drm) {
      throw new EpubImportError(
        "drm",
        `This EPUB is DRM-protected (${this.encryption.drmReason}). Only DRM-free EPUBs are supported.`,
      );
    }
    const container = this.entryMap.get("META-INF/container.xml");
    if (!container)
      throw new EpubImportError("invalid", "Not an EPUB: META-INF/container.xml is missing.");
    const opfPath = findOpfPath(this.textOf("META-INF/container.xml"));
    if (!this.entryMap.has(opfPath)) {
      throw new EpubImportError(
        "invalid",
        `The package file ${opfPath} is missing from the archive.`,
      );
    }
    this.pkg = parsePackage(this.textOf(opfPath), opfPath);
    if (this.pkg.fixedLayout && options.rejectFixedLayout !== false) {
      throw new EpubImportError(
        "fixed-layout",
        "This is a fixed-layout EPUB (pages laid out like a PDF). Only reflowable EPUBs are supported.",
      );
    }

    const cssTexts = this.pkg.manifest
      .filter((m) => m.mediaType === "text/css" && this.entryMap.has(m.path))
      .map((m) => this.textOf(m.path));
    this.css = scanCss(cssTexts);

    const docs: BookDoc[] = [];
    const seen = new Set<string>();
    const byId = new Map(this.pkg.manifest.map((m) => [m.id, m]));
    this.pkg.spine.forEach((item, spinePos) => {
      const m = byId.get(item.idref);
      if (!m || !XHTML_TYPES.has(m.mediaType) || !this.entryMap.has(m.path) || seen.has(m.path))
        return;
      seen.add(m.path);
      docs.push({
        index: docs.length,
        path: m.path,
        mediaType: m.mediaType,
        manifestId: m.id,
        inSpine: true,
        spinePos,
        linear: item.linear,
        isNav: m.path === this.pkg.navPath,
      });
    });
    for (const m of this.pkg.manifest) {
      if (!XHTML_TYPES.has(m.mediaType) || !this.entryMap.has(m.path) || seen.has(m.path)) continue;
      seen.add(m.path);
      docs.push({
        index: docs.length,
        path: m.path,
        mediaType: m.mediaType,
        manifestId: m.id,
        inSpine: false,
        spinePos: null,
        linear: false,
        isNav: m.path === this.pkg.navPath,
      });
    }
    this.docs = docs;

    this.navToc =
      this.pkg.navPath && this.entryMap.has(this.pkg.navPath)
        ? safeToc(() => parseNavToc(this.textOf(this.pkg.navPath!), this.pkg.navPath!))
        : [];
    this.ncxToc =
      this.pkg.ncxPath && this.entryMap.has(this.pkg.ncxPath)
        ? safeToc(() => parseNcx(this.textOf(this.pkg.ncxPath!), this.pkg.ncxPath!))
        : [];
    const chosen = chooseToc(this.navToc, this.ncxToc);
    this.toc = chosen.entries;
    this.tocSource = chosen.source;
  }

  static open(bytes: Uint8Array, options: OpenOptions = {}): EpubBook {
    let entries: ZipEntry[];
    try {
      entries = readZip(bytes, options.limits ?? DEFAULT_ZIP_LIMITS);
    } catch (error) {
      throw new EpubImportError(
        "invalid",
        `Can't read the file as an EPUB: ${(error as Error).message}`,
      );
    }
    return new EpubBook(entries, options);
  }

  textOf(path: string): string {
    const entry = this.entryMap.get(path);
    if (!entry) throw new Error(`Missing file in the EPUB: ${path}`);
    return decodeXmlBytes(entry.data).text;
  }

  get title(): string {
    return this.pkg.titles[0] ?? "Untitled";
  }

  doc(index: number): LoadedDoc {
    const cached = this.loaded.get(index);
    if (cached) return cached;
    const info = this.docs[index];
    if (!info) throw new Error(`No document ${index}`);
    const entry = this.entryMap.get(info.path)!;
    const decoded = decodeXmlBytes(entry.data);
    const dom = parseXml(decoded.text);
    const flow = buildFlow(decoded.text, dom, {
      preClasses: this.css.preClasses,
      isNav: info.isNav,
    });
    const loaded: LoadedDoc = { info, decoded, src: decoded.text, dom, flow };
    this.loaded.set(index, loaded);
    return loaded;
  }

  docByPath(path: string): BookDoc | undefined {
    return this.docs.find((d) => d.path === path);
  }

  /** Strict XML problems and other notes about the book. */
  diagnose(): Diagnostic[] {
    const out: Diagnostic[] = [];
    const add = (d: Omit<Diagnostic, "count" | "docIndex"> & { docIndex?: number | null }) => {
      const existing = out.find((o) => o.code === d.code && o.docIndex === (d.docIndex ?? null));
      if (existing) existing.count++;
      else out.push({ docIndex: null, count: 1, ...d });
    };
    if (this.pkg.hasMediaOverlays) {
      add({
        level: "warning",
        code: "media-overlays",
        message: "Read-aloud audio (media overlays) will be removed from the translation.",
      });
    }
    if (this.encryption.obfuscatedFonts.length > 0 || this.css.hasFontFace) {
      add({
        level: "info",
        code: "embedded-fonts",
        message: "The book embeds fonts; they may lack characters the translation needs.",
      });
    }
    if (this.tocSource === "none") {
      add({
        level: "warning",
        code: "no-toc",
        message: "The book has no table of contents; chapters are guessed from files.",
      });
    }
    for (const doc of this.docs) {
      const loaded = this.doc(doc.index);
      for (const problem of strictXmlProblems(loaded.src)) {
        add({ level: "warning", code: "xml", message: problem, docIndex: doc.index });
      }
      const unsafe = loaded.flow.units.filter((u) => u.kind !== "break" && !u.safe).length;
      if (unsafe > 0) {
        add({
          level: "warning",
          code: "unsafe-units",
          message: `${unsafe} paragraph(s) have broken markup and will stay untranslated.`,
          docIndex: doc.index,
        });
      }
      if (/<(?:\w+:)?switch[\s>]/.test(loaded.src)) {
        add({
          level: "info",
          code: "epub-switch",
          message: "Contains epub:switch content; its fallback text stays untranslated.",
          docIndex: doc.index,
        });
      }
      if (
        /<(?:\w+:)?svg[\s>][\s\S]*?<(?:\w+:)?text[\s>]/.test(loaded.src) ||
        /<(?:\w+:)?mtext[\s>]/.test(loaded.src)
      ) {
        add({
          level: "info",
          code: "svg-math-text",
          message: "Text inside SVG or MathML stays untranslated.",
          docIndex: doc.index,
        });
      }
    }
    return out;
  }
}

function safeToc(fn: () => TocEntry[]): TocEntry[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

/** Strict XML errors, ignoring HTML named entities when the file declares a DTD (readers resolve those). */
export function strictXmlProblems(src: string, limit = 3): string[] {
  const problems: string[] = [];
  const hasDtd = /<!DOCTYPE[^>]*(DTD|\.dtd)/i.test(src.slice(0, 2000));
  const lines = src.split("\n");
  const parser = new SaxesParser({ xmlns: false });
  parser.on("error", (err) => {
    let message = err.message.replace(/^undefined:/, "").trim();
    const pos = /^(\d+):(\d+):\s*(.*)$/.exec(message);
    if (pos && /undefined entity/i.test(pos[3] ?? "")) {
      const line = lines[Number(pos[1]) - 1] ?? "";
      const col = Number(pos[2]);
      const amp = line.lastIndexOf("&", col);
      const semi = amp >= 0 ? line.indexOf(";", amp) : -1;
      const name = amp >= 0 && semi > amp ? line.slice(amp + 1, semi) : null;
      if (name) {
        const known = decodeHTMLStrict(`&${name};`) !== `&${name};`;
        if (known && hasDtd) return;
        message = known
          ? `Uses the HTML entity &${name}; without declaring it; some readers may reject this file.`
          : `Unknown entity &${name};.`;
      }
    }
    if (problems.length < limit) problems.push(message);
  });
  try {
    parser.write(src).close();
  } catch (error) {
    if (problems.length < limit) problems.push((error as Error).message);
  }
  return problems;
}
