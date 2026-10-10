import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonical } from "../testing/canonical.ts";
import { buildFixtureEpub } from "../testing/epub-fixtures.ts";
import { extractDocUnits, type TransUnit } from "./blocks.ts";
import { EpubBook, strictXmlProblems } from "./book.ts";
import { buildTranslatedEpub, extractTocUnits } from "./write.ts";
import { readZip } from "./zip.ts";

const word = fc.stringMatching(/^[A-Za-z]{1,8}$/);
const text = fc
  .array(fc.oneof(word, fc.constantFrom(" ", ", ", ". ", "\u00a0")), { minLength: 1, maxLength: 5 })
  .map((p) => p.join(""));

const inline: fc.Memo<string> = fc.memo((depth) => {
  const leaf = fc.oneof(
    { weight: 5, arbitrary: text },
    { weight: 1, arbitrary: fc.constant("<br/>") },
    // Alt texts of 2+ letters: a single-letter image before a word is an image drop cap,
    // which is intentionally replaced by its letter.
    {
      weight: 1,
      arbitrary: fc.stringMatching(/^[A-Za-z]{2,8}$/).map((w) => `<img src="i.png" alt="${w}"/>`),
    },
    { weight: 1, arbitrary: fc.constant('<a epub:type="noteref" href="n.xhtml#1">1</a>') },
    { weight: 1, arbitrary: fc.constant('<span epub:type="pagebreak" id="pg" title="3"/>') },
  );
  if (depth <= 0) return leaf;
  const element = fc
    .tuple(
      fc.constantFrom("i", "b", "em", 'span class="c"', 'a href="x.xhtml"', "sup", "small"),
      fc.array(inline(depth - 1), { minLength: 1, maxLength: 3 }),
    )
    .map(([tag, kids]) => `<${tag}>${kids.join("")}</${tag.split(" ")[0]}>`);
  return fc.oneof({ weight: 3, arbitrary: leaf }, { weight: 2, arbitrary: element });
});

const paragraph = fc
  .array(inline(3), { minLength: 1, maxLength: 6 })
  .map((parts) => `<p>${parts.join("")}w</p>`);
const body = fc.array(paragraph, { minLength: 1, maxLength: 4 }).map((ps) => ps.join("\n"));

function build(bodyHtml: string, translate: (u: TransUnit) => string) {
  const book = EpubBook.open(buildFixtureEpub({ docs: [{ path: "a.xhtml", body: bodyHtml }] }));
  const units = extractDocUnits(book, 0);
  const translations = new Map<string, string>();
  for (const u of units) if (u.translate) translations.set(u.key, translate(u));
  const result = buildTranslatedEpub({
    book,
    sourceLang: "en",
    targetLang: "de",
    direction: "ltr",
    unitsByDoc: new Map([[0, units]]),
    tocUnits: extractTocUnits(book),
    translations,
    keepDocs: new Set(),
    title: null,
    newIdentifier: false,
    removeEmbeddedFonts: false,
  });
  const before = book.doc(0).src;
  const after = new TextDecoder().decode(
    readZip(result.bytes).find((e) => e.name === "OEBPS/a.xhtml")!.data,
  );
  return { before, after, units };
}

describe("splice properties", () => {
  it("identity translation keeps documents canonically equal and well-formed", () => {
    fc.assert(
      fc.property(body, (html) => {
        const { before, after } = build(html, (u) => u.text);
        expect(canonical(after)).toBe(canonical(before));
        expect(strictXmlProblems(after)).toEqual(strictXmlProblems(before));
      }),
      { numRuns: 150 },
    );
  });

  it("compares merged wrappers the same however their children were split", () => {
    // Found by the property above: merging the two <em>s makes their links
    // neighbours, which the canonical form must then merge too.
    const html =
      '<p><em><a href="x.xhtml">aaA</a></em><em><a href="x.xhtml"><img src="i.png" alt="Aa"/></a>A</em><i>A</i>w</p>';
    const { before, after } = build(html, (u) => u.text);
    expect(canonical(after)).toBe(canonical(before));
    expect(after).toContain('<a href="x.xhtml">aaA</a><a href="x.xhtml"><img');
  });

  it("dropping optional placeholders still gives well-formed XML", () => {
    fc.assert(
      fc.property(body, (html) => {
        const { after } = build(html, (u) => {
          let t = u.text;
          for (const p of u.placeholders) {
            if (p.kind === "g" && !p.required)
              t = t.replace(`<g${p.n}>`, "").replace(`</g${p.n}>`, "");
          }
          return t
            .toUpperCase()
            .replace(/<(\/?)G(\d+)>/g, "<$1g$2>")
            .replace(/<X(\d+)\/>/g, "<x$1/>");
        });
        expect(strictXmlProblems(after)).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });
});
