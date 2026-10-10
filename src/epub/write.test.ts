import { describe, expect, it } from "vitest";
import { canonical } from "../testing/canonical.ts";
import { buildFixtureEpub, sampleNovel } from "../testing/epub-fixtures.ts";
import { extractDocUnits, type TransUnit } from "./blocks.ts";
import { EpubBook, EpubImportError } from "./book.ts";
import { idpfKey, obfuscate } from "./identity.ts";
import { FONT_OBFUSCATION_IDPF } from "./inspect.ts";
import { applyEdits, OverlapError } from "./splice.ts";
import { type BuildInput, buildTranslatedEpub, extractTocUnits } from "./write.ts";
import { readZip } from "./zip.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

function prepare(
  bytes: Uint8Array,
  translate: (u: TransUnit) => string | undefined,
  extra: Partial<BuildInput> = {},
) {
  const book = EpubBook.open(bytes);
  const unitsByDoc = new Map<number, TransUnit[]>();
  const translations = new Map<string, string>();
  for (const doc of book.docs) {
    const units = extractDocUnits(book, doc.index);
    unitsByDoc.set(doc.index, units);
    for (const u of units) {
      const t = u.translate ? translate(u) : undefined;
      if (t !== undefined) translations.set(u.key, t);
    }
  }
  const tocUnits = extractTocUnits(book);
  for (const u of tocUnits) {
    const t = u.translate ? translate(u) : undefined;
    if (t !== undefined) translations.set(u.key, t);
  }
  const input: BuildInput = {
    book,
    sourceLang: "en",
    targetLang: "pl",
    direction: "ltr",
    unitsByDoc,
    tocUnits,
    translations,
    keepDocs: new Set(),
    title: null,
    newIdentifier: false,
    removeEmbeddedFonts: false,
    now: new Date("2026-10-10T12:34:56.789Z"),
    ...extra,
  };
  return { book, input, result: buildTranslatedEpub(input) };
}

function fileText(bytes: Uint8Array, name: string): string {
  const entry = readZip(bytes).find((e) => e.name === name);
  if (!entry) throw new Error(`missing ${name}`);
  return dec.decode(entry.data);
}

const upper = (u: TransUnit) =>
  u.text.replace(/(^|>)([^<]+)/g, (_m, a: string, b: string) => a + b.toUpperCase());

describe("identity round trip", () => {
  for (const version of ["2.0", "3.0"] as const) {
    it(`keeps every document canonically identical (EPUB ${version})`, () => {
      const bytes = sampleNovel(version);
      const { book, result } = prepare(bytes, (u) => u.text);
      for (const doc of book.docs) {
        const before = book.doc(doc.index).src;
        const after = fileText(result.bytes, doc.path);
        expect(canonical(after), doc.path).toBe(canonical(before));
      }
      expect(result.report.newXmlProblems).toEqual([]);
    });
  }

  it("leaves bytes outside edited ranges untouched", () => {
    const { book, result } = prepare(sampleNovel(), (u) => u.text);
    const before = book.doc(1).src;
    const after = fileText(result.bytes, "OEBPS/text/ch1.xhtml");
    // Everything up to <html …> is unchanged, and the tail after the last paragraph too.
    expect(after.slice(0, 40)).toBe(before.slice(0, 40));
    expect(after.slice(-40)).toBe(before.slice(-40));
  });
});

describe("translated output", () => {
  it("writes translations, keeps structure, and updates languages (EPUB 3)", () => {
    const { result } = prepare(sampleNovel(), upper, { title: "Latarnik" });
    const ch1 = fileText(result.bytes, "OEBPS/text/ch1.xhtml");
    expect(ch1).toContain('lang="pl" xml:lang="pl"');
    expect(ch1).toContain('<span class="dropcap">M</span>IRA CLIMBED');
    expect(ch1).toContain('<a epub:type="noteref" href="notes.xhtml#n1" id="r1">1</a>');
    expect(ch1).toContain('alt="A FIVE-POINTED STAR"');
    const opf = fileText(result.bytes, "OEBPS/content.opf");
    expect(opf).toContain("<dc:language>pl</dc:language>");
    expect(opf).toContain('<dc:title id="title" xml:lang="pl">Latarnik</dc:title>');
    expect(opf).toMatch(/<meta property="dcterms:modified">2026-10-10T12:34:56Z<\/meta>/);
    expect(opf).toContain(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="pl">',
    );
    const nav = fileText(result.bytes, "OEBPS/nav.xhtml");
    expect(nav).toContain(">CHAPTER ONE</a>");
    expect(nav).toContain("<h1>CONTENTS</h1>");
    const ncx = fileText(result.bytes, "OEBPS/toc.ncx");
    expect(ncx).toContain(
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="pl">',
    );
    expect(ncx).toContain("<text>SECOND SCENE</text>");
  });

  it("doesn't add a lang attribute to EPUB 2 documents", () => {
    const { result } = prepare(sampleNovel("2.0"), upper);
    const ch1 = fileText(result.bytes, "OEBPS/text/ch1.xhtml");
    expect(ch1).toContain('<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="pl">');
    expect(ch1).not.toMatch(/<html[^>]* lang=/);
  });

  it("rewrites source-language lang attributes outside units but not foreign ones", () => {
    const bytes = buildFixtureEpub({
      docs: [
        {
          path: "a.xhtml",
          body: '<div lang="en-US"><p>Hello there.</p><p xml:lang="fr">Bonjour.</p></div>',
          bodyAttrs: ' lang="en"',
        },
      ],
    });
    const { result } = prepare(bytes, upper);
    const a = fileText(result.bytes, "OEBPS/a.xhtml");
    expect(a).toContain('<body lang="pl">');
    expect(a).toContain('<div lang="pl">');
    expect(a).toContain('<p xml:lang="fr">');
  });

  it("sets right-to-left direction for RTL targets", () => {
    const { result } = prepare(sampleNovel(), upper, { targetLang: "he", direction: "rtl" });
    expect(fileText(result.bytes, "OEBPS/text/ch1.xhtml")).toMatch(/<html[^>]*dir="rtl"/);
    expect(fileText(result.bytes, "OEBPS/content.opf")).toContain(
      '<spine toc="ncx" page-progression-direction="rtl">',
    );
  });

  it("keeps files set to 'keep original' byte-identical", () => {
    const bytes = sampleNovel();
    const { result } = prepare(bytes, upper, { keepDocs: new Set([2]) });
    const original = readZip(bytes).find((e) => e.name === "OEBPS/text/ch2.xhtml")!.data;
    const output = readZip(result.bytes).find((e) => e.name === "OEBPS/text/ch2.xhtml")!.data;
    expect(output).toEqual(original);
  });

  it("keeps untranslated units and their language as they were", () => {
    const { result } = prepare(sampleNovel(), (u) =>
      u.text.startsWith("The storm") ? undefined : upper(u),
    );
    const ch2 = fileText(result.bytes, "OEBPS/text/ch2.xhtml");
    expect(ch2).toContain("The storm came at midnight.");
    expect(ch2).toContain("THE MORNING WAS QUIET.");
    expect(result.report.untranslatedUnits).toBe(1);
  });

  it("gives the book a new identifier and re-obfuscates fonts for it", () => {
    const oldId = "urn:uuid:12345678-1234-4234-8234-123456789abc";
    const font = enc.encode("FONTDATA".repeat(300));
    const obfuscated = obfuscate(font, FONT_OBFUSCATION_IDPF, idpfKey(oldId));
    const encryption = `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><enc:CipherData><enc:CipherReference URI="OEBPS/fonts/f.otf"/></enc:CipherData></enc:EncryptedData></encryption>`;
    const bytes = buildFixtureEpub({
      identifier: oldId,
      docs: [{ path: "a.xhtml", body: "<p>Text.</p>" }],
      extraManifest: [{ id: "font", path: "fonts/f.otf", mediaType: "font/otf", data: obfuscated }],
      extraEntries: [{ name: "META-INF/encryption.xml", data: enc.encode(encryption) }],
    });
    const { result } = prepare(bytes, upper, { newIdentifier: true });
    const newId = result.report.identifier!.new;
    expect(newId).toMatch(/^urn:uuid:/);
    const outFont = readZip(result.bytes).find((e) => e.name === "OEBPS/fonts/f.otf")!.data;
    expect(obfuscate(outFont, FONT_OBFUSCATION_IDPF, idpfKey(newId))).toEqual(font);
    const opf = fileText(result.bytes, "OEBPS/content.opf");
    expect(opf).toContain(`<dc:identifier id="bookid">${newId}</dc:identifier>`);
    expect(opf).toContain(`<dc:source>${oldId}</dc:source>`);
    expect(fileText(result.bytes, "OEBPS/toc.ncx")).toContain(`content="${newId}"`);
  });

  it("lists letters the embedded fonts may lack", () => {
    const bytes = buildFixtureEpub({
      docs: [{ path: "a.xhtml", body: "<p>Hello.</p>" }],
      css: "@font-face { font-family: X; src: url(x.otf); }",
    });
    const { result } = prepare(bytes, () => "Cześć.");
    expect(result.report.missingGlyphs).toEqual(expect.arrayContaining(["ś", "ć"]));
  });
});

describe("import checks", () => {
  it("rejects DRM-protected books", () => {
    const bytes = buildFixtureEpub({
      docs: [{ path: "a.xhtml", body: "<p>x</p>" }],
      extraEntries: [{ name: "META-INF/sinf.xml", data: enc.encode("<sinf/>") }],
    });
    expect(() => EpubBook.open(bytes)).toThrow(EpubImportError);
  });

  it("rejects fixed-layout books", () => {
    const bytes = buildFixtureEpub({
      docs: [{ path: "a.xhtml", body: "<p>x</p>" }],
      metadataExtra: '\n    <meta property="rendition:layout">pre-paginated</meta>',
    });
    expect(() => EpubBook.open(bytes)).toThrow(/fixed-layout/);
  });

  it("reads documents outside the spine and percent-encoded file names", () => {
    const bytes = buildFixtureEpub({
      docs: [
        { path: "Rozdział.xhtml", href: "Rozdzia%C5%82.xhtml", body: "<p>Chapter.</p>" },
        { path: "endnotes.xhtml", body: "<p>A note.</p>", inSpine: false },
      ],
    });
    const book = EpubBook.open(bytes);
    expect(book.docs.map((d) => [d.path, d.inSpine])).toEqual([
      ["OEBPS/Rozdział.xhtml", true],
      ["OEBPS/endnotes.xhtml", false],
      ["OEBPS/nav.xhtml", false],
    ]);
  });
});

describe("edits", () => {
  it("refuses overlapping edits", () => {
    expect(() =>
      applyEdits("abcdef", [
        { start: 0, end: 3, text: "x" },
        { start: 2, end: 4, text: "y" },
      ]),
    ).toThrow(OverlapError);
    expect(
      applyEdits("abcdef", [
        { start: 4, end: 6, text: "Z" },
        { start: 0, end: 1, text: "A" },
      ]),
    ).toBe("AbcdZ");
  });
});
