import type { Element } from "domhandler";
import { describe, expect, it } from "vitest";
import {
  declareUtf8,
  decodeText,
  decodeXmlBytes,
  elementRanges,
  findAll,
  localName,
  parseOpenTag,
  parseXml,
  removeXmlIllegal,
  rewriteOpenTag,
} from "./xhtml.ts";

function first(src: string, name: string): Element {
  const el = findAll(parseXml(src), (e) => localName(e) === name)[0];
  if (!el) throw new Error(`no <${name}>`);
  return el;
}

describe("element ranges", () => {
  it("gives exact ranges with an inclusive endIndex", () => {
    const src = '<p class="a">Hi <i>there</i></p>';
    const r = elementRanges(src, first(src, "i"))!;
    expect(src.slice(r.start, r.end)).toBe("<i>there</i>");
    expect(src.slice(r.innerStart, r.innerEnd)).toBe("there");
  });

  it("handles self-closing tags and > inside attribute values", () => {
    const src = '<p><img alt="a > b" src="x.png"/>text</p>';
    const r = elementRanges(src, first(src, "img"))!;
    expect(r.selfClosing).toBe(true);
    expect(src.slice(r.start, r.end)).toBe('<img alt="a > b" src="x.png"/>');
  });

  it("rejects implicitly closed elements", () => {
    const src = "<body><p><i>unclosed</p></body>";
    expect(elementRanges(src, first(src, "i"))).toBeNull();
    expect(elementRanges(src, first(src, "p"))).not.toBeNull();
  });
});

describe("decoding", () => {
  it("decodes entities strictly", () => {
    expect(decodeText("a&nbsp;b &amp; &#8212; &copy2020")).toBe("a\u00a0b & — &copy2020");
  });

  it("detects encodings from BOM and declaration", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    expect(decodeXmlBytes(bom)).toMatchObject({ text: "A", hadBom: true });
    const latin = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?><p>'),
      0xe9,
      ...new TextEncoder().encode("</p>"),
    ]);
    expect(decodeXmlBytes(latin).text).toContain("<p>é</p>");
  });

  it("rewrites encoding declarations to UTF-8", () => {
    expect(
      declareUtf8('<?xml version="1.0" encoding="ISO-8859-1"?><meta charset="iso-8859-1"/>'),
    ).toBe('<?xml version="1.0" encoding="UTF-8"?><meta charset="utf-8"/>');
  });

  it("removes characters that are illegal in XML", () => {
    expect(removeXmlIllegal("a\u0001b\u000bc\ufffed")).toBe("abcd");
  });
});

describe("opening tags", () => {
  it("parses attributes with their positions", () => {
    const tag = `<p class="x" lang='en-US' hidden>`;
    const parsed = parseOpenTag(tag);
    expect(parsed.name).toBe("p");
    expect(parsed.attrs.map((a) => [a.name, a.value, a.quote])).toEqual([
      ["class", "x", '"'],
      ["lang", "en-US", "'"],
      ["hidden", "", null],
    ]);
  });

  it("rewrites, sets and removes attributes without touching the rest", () => {
    const tag = `<html xmlns="http://www.w3.org/1999/xhtml" lang='en'>`;
    expect(rewriteOpenTag(tag, { set: { lang: "pl", "xml:lang": "pl" } })).toBe(
      `<html xmlns="http://www.w3.org/1999/xhtml" lang='pl' xml:lang="pl">`,
    );
    expect(rewriteOpenTag('<img src="a.png" alt="x"/>', { set: { alt: 'say "hi"' } })).toBe(
      '<img src="a.png" alt="say &quot;hi&quot;"/>',
    );
    expect(rewriteOpenTag('<dc:title id="t" opf:file-as="X">', { remove: ["opf:file-as"] })).toBe(
      '<dc:title id="t">',
    );
  });
});
