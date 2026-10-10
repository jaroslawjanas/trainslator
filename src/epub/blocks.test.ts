import { describe, expect, it } from "vitest";
import { buildFixtureEpub, sampleNovel } from "../testing/epub-fixtures.ts";
import { extractDocUnits, type TransUnit } from "./blocks.ts";
import { EpubBook } from "./book.ts";
import { renderTranslatedUnit } from "./splice.ts";

const LANG = { sourceLang: "en", targetLang: "pl" };

function unitsOf(body: string, version: "2.0" | "3.0" = "3.0"): TransUnit[] {
  const book = EpubBook.open(buildFixtureEpub({ version, docs: [{ path: "t.xhtml", body }] }));
  return extractDocUnits(book, 0).filter((u) => u.role !== "title");
}

function textsOf(body: string): string[] {
  return unitsOf(body).map((u) => u.text);
}

describe("translation units", () => {
  it("turns inline markup into placeholders", () => {
    const [u] = unitsOf(
      '<p>She kept a <i>small</i> notebook.<a epub:type="noteref" href="n.xhtml#1">1</a></p>',
    );
    expect(u!.text).toBe("She kept a <g1>small</g1> notebook.<x2/>");
    expect(u!.placeholders.map((p) => [p.kind, p.required, p.label])).toEqual([
      ["g", false, "i"],
      ["x", true, "note reference"],
    ]);
  });

  it("marks links and elements with ids as required", () => {
    const [u] = unitsOf(
      '<p>See the <a href="c2.xhtml">next chapter</a> and <span id="x">this</span>.</p>',
    );
    expect(u!.placeholders.map((p) => p.required)).toEqual([true, true]);
  });

  it("moves whole-paragraph wrappers and edge anchors outside the unit", () => {
    const [u] = unitsOf('<p> <a id="p7"/><span class="c5">All wrapped.</span> </p>');
    expect(u!.text).toBe("All wrapped.");
    expect(u!.prefix).toBe(' <a id="p7"/><span class="c5">');
    expect(u!.suffix).toBe("</span> ");
  });

  it("detects drop caps and re-applies them to the translation", () => {
    const [u] = unitsOf('<p><span class="dc">“T</span>he night was cold.</p>');
    expect(u!.text).toBe("“The night was cold.");
    expect(u!.dropCap).toEqual({ open: '<span class="dc">', close: "</span>" });
    expect(renderTranslatedUnit(u!, "„Noc była zimna.", { lang: LANG })).toBe(
      '<span class="dc">„N</span>oc była zimna.',
    );
  });

  it("merges identical spans split mid-word and unwraps other mid-word spans", () => {
    const [u] = unitsOf(
      '<p>the <span class="b">wi</span><span class="b">nd</span> and li<span class="x">ght</span></p>',
    );
    expect(u!.text).toBe("the <g1>wind</g1> and light");
  });

  it("keeps newlines of preformatted text as placeholders", () => {
    const [u] = unitsOf("<pre>line one\nline two</pre>");
    expect(u!.text).toBe("line one<x1/>line two");
    expect(renderTranslatedUnit(u!, "linia jeden<x1/>linia dwa", { lang: LANG })).toBe(
      "linia jeden\nlinia dwa",
    );
  });

  it("treats CSS white-space: pre classes as preformatted", () => {
    const book = EpubBook.open(
      buildFixtureEpub({
        docs: [{ path: "t.xhtml", body: '<div class="verse">a\nb</div>' }],
        css: ".verse { white-space: pre-line }",
      }),
    );
    const u = extractDocUnits(book, 0).find((x) => x.role !== "title")!;
    expect(u.text).toBe("a<x1/>b");
  });

  it("splits mixed content into runs and handles inline elements that wrap blocks", () => {
    expect(
      textsOf(
        '<div>Loose text, <em>emph</em>.<p>Inner paragraph.</p>Tail text.</div><a href="x.xhtml"><p>Linked paragraph.</p></a>',
      ),
    ).toEqual([
      "Loose text, <g1>emph</g1>.",
      "Inner paragraph.",
      "Tail text.",
      "Linked paragraph.",
    ]);
  });

  it("gives list text before a nested list the list-item role", () => {
    const units = unitsOf("<ul><li>Outer<ul><li>Inner</li></ul></li></ul>");
    expect(units.map((u) => [u.text, u.role])).toEqual([
      ["Outer", "list-item"],
      ["Inner", "list-item"],
    ]);
  });

  it("removes comments, soft hyphens, <wbr> and Kobo spans", () => {
    const [u] = unitsOf(
      '<p>a<!-- c -->b soft&#173;ware ex<wbr/>tra <span class="koboSpan" id="kobo.1.1">kobo</span></p>',
    );
    expect(u!.text).toBe("ab software extra kobo");
  });

  it("marks units with broken markup as unsafe and units without letters as skipped", () => {
    const units = unitsOf("<p><i>unclosed</p><p>* * *</p><p>12</p>");
    expect(units.map((u) => [u.translate, u.skipReason?.slice(0, 8)])).toEqual([
      [false, "<i> isn'"],
      [false, "no lette"],
      [false, "no lette"],
    ]);
  });

  it("extracts alt texts as separate units, inside and outside text", () => {
    const units = unitsOf(
      '<p>A <img src="a.png" alt="small bird"/> flew.</p><figure><img src="b.png" alt="A map"/></figure><p><img src="c.png" alt="c.png"/></p>',
    );
    const alts = units.filter((u) => u.kind === "alt");
    expect(alts.map((u) => [u.text, u.owner !== null])).toEqual([
      ["small bird", true],
      ["A map", false],
    ]);
  });

  it("keeps NBSP and other Unicode spaces", () => {
    const [u] = unitsOf("<p>Pepper&nbsp;&#8212; why</p>");
    expect(u!.text).toBe("Pepper\u00a0— why");
  });

  it("gives every unit a stable key", () => {
    const book = EpubBook.open(sampleNovel());
    const a = extractDocUnits(book, 1).map((u) => u.key);
    const b = extractDocUnits(EpubBook.open(sampleNovel()), 1).map((u) => u.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe("rendering translations", () => {
  it("restores tags, escapes text and cleans model output", () => {
    const [u] = unitsOf('<p>Read <a href="x.xhtml">this</a> &amp; <i>that</i>.</p>');
    const out = renderTranslatedUnit(u!, "Czytaj <g1>to</g1> &amp; <g2>tamto</g2> < 3\n.", {
      lang: LANG,
    });
    expect(out).toBe('Czytaj <a href="x.xhtml">to</a> &amp; <i>tamto</i> &lt; 3 .');
  });

  it("allows optional placeholders to be dropped", () => {
    const [u] = unitsOf("<p>She was the 19<sup>th</sup> keeper.</p>");
    expect(renderTranslatedUnit(u!, "Była dziewiętnastą latarniczką.", { lang: LANG })).toBe(
      "Była dziewiętnastą latarniczką.",
    );
  });

  it("rewrites source-language lang attributes inside the unit", () => {
    const [u] = unitsOf(
      '<p>A <span lang="en-GB" class="q">quote</span> and <span xml:lang="fr">bonjour</span>.</p>',
    );
    expect(
      renderTranslatedUnit(u!, "Cytat <g1>cytat</g1> i <g2>bonjour</g2>.", { lang: LANG }),
    ).toBe('Cytat <span lang="pl" class="q">cytat</span> i <span xml:lang="fr">bonjour</span>.');
  });
});
