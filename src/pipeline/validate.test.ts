import { describe, expect, it } from "vitest";
import { extractDocUnits } from "../epub/blocks.ts";
import { EpubBook } from "../epub/book.ts";
import { buildFixtureEpub } from "../testing/epub-fixtures.ts";
import { type CheckContext, checkUnitTranslation, languageChecks } from "./validate.ts";

/** One unit per paragraph. */
function units(...paragraphs: string[]) {
  const book = EpubBook.open(
    buildFixtureEpub({
      docs: [{ path: "t.xhtml", body: paragraphs.map((p) => `<p>${p}</p>`).join("\n") }],
    }),
  );
  return extractDocUnits(book, 0).filter((u) => u.role !== "title");
}

function ctx(sourceLang: string, targetLang: string): CheckContext {
  return { targetScripts: ["Latn"], ratio: 1, languages: languageChecks(sourceLang, targetLang) };
}

function check(source: string, text: string, c: CheckContext) {
  return checkUnitTranslation(units(source)[0]!, text, c);
}

const PREAMBLE = "starts with a preamble instead of the translation";

describe("preambles", () => {
  it("keeps the English rule for English sources", () => {
    const source = "Mira climbed the hundred steps of the lighthouse every evening.";
    for (const text of ["Sure, here it is.", "Here is the translation: Mira co wieczór…"])
      expect(check(source, text, ctx("en", "pl")).errors).toContain(PREAMBLE);
  });

  it("lets a German or Polish source be translated as “Sure, …”", () => {
    const de = check(
      "Klar, ich komme morgen früh mit.",
      "Sure, I'll come along tomorrow morning.",
      ctx("de", "en"),
    );
    expect(de.errors).toEqual([]);
    const pl = check(
      "Jasne, przyjdę jutro rano.",
      "Sure, I'll come tomorrow morning.",
      ctx("pl", "en"),
    );
    expect(pl.errors).toEqual([]);
  });

  it("still catches real preambles from any source", () => {
    const source = "Klar, ich komme morgen früh mit.";
    for (const text of [
      "Here is the translation: Sure, I'll come along tomorrow morning.",
      "Sure, here's the translation:\nI'll come along tomorrow morning.",
      "Translation: Sure, I'll come along tomorrow morning.",
    ])
      expect([text, check(source, text, ctx("de", "en")).errors]).toEqual([text, [PREAMBLE]]);
  });

  it("catches preambles in the target language", () => {
    const source = "Klar, ich komme morgen früh mit.";
    for (const text of [
      "Oto tłumaczenie: Jasne, przyjdę jutro rano.",
      "Tłumaczenie: Jasne, przyjdę jutro rano.",
    ])
      expect(check(source, text, ctx("de", "pl")).errors).toEqual([PREAMBLE]);
    // A translation that only starts like one is fine.
    expect(check("Hier ist der Schlüssel.", "Oto klucz.", ctx("de", "pl")).errors).toEqual([]);
    expect(check("Hier ist der Schlüssel.", "Here is the key.", ctx("de", "en")).errors).toEqual(
      [],
    );
  });
});

describe("leftovers in the source language", () => {
  const warning = (lang: string) => `may still be partly in ${lang}`;

  it("warns when a translation is still in the source language", () => {
    const en = check(
      "Mira climbed the hundred steps of the lighthouse every evening, and she counted them.",
      "Mira climbed the steps of the lighthouse every evening, and she counted them all.",
      ctx("en", "pl"),
    );
    expect(en.warnings).toEqual([warning("English")]);
    const de = check(
      "Mira stieg jeden Abend die hundert Stufen des Leuchtturms hinauf und zählte sie.",
      "Mira stieg jeden Abend die Stufen des Leuchtturms hinauf, und sie zählte sie immer.",
      ctx("de", "en"),
    );
    expect(de.warnings).toEqual([warning("German")]);
    const pl = check(
      "Mira co wieczór wspinała się po stu stopniach latarni i liczyła je, ale nie mówiła nic.",
      "Mira co wieczór wspinała się po stopniach latarni i je liczyła, ale nic nie mówiła.",
      ctx("pl", "en"),
    );
    expect(pl.warnings).toEqual([warning("Polish")]);
  });

  it("warns once when the text is just copied", () => {
    const source = "Mira climbed the hundred steps of the lighthouse every evening.";
    expect(check(source, source, ctx("en", "pl")).warnings).toEqual([
      "identical to the source (untranslated?)",
    ]);
  });

  it("leaves real translations alone", () => {
    const pairs: [string, string, string, string][] = [
      [
        "en",
        "pl",
        "Mira climbed the hundred steps of the lighthouse every evening, and she counted them.",
        "Mira co wieczór wspinała się po stu stopniach latarni i liczyła je.",
      ],
      [
        "en",
        "de",
        "He said that it was all in the past, and that he had to go home to his wife.",
        "Er sagte, das sei alles Vergangenheit, und er müsse nach Hause zu seiner Frau.",
      ],
      [
        "de",
        "en",
        "Sie war nicht mehr in der Stadt, und er wusste nicht, wo sie jetzt wohnte.",
        "She wasn't in the city any more, and he didn't know where she lived now.",
      ],
      [
        "pl",
        "en",
        "Nie było jej już w mieście, a on nie wiedział, gdzie teraz mieszka, więc czekał.",
        "She was no longer in the city, and he did not know where she lived now, so he waited.",
      ],
      [
        "de",
        "pl",
        "Sie war nicht mehr in der Stadt, und ich wusste nicht, wo sie jetzt wohnte.",
        "Nie było jej już w mieście, a ja nie wiedziałem, gdzie teraz mieszka.",
      ],
      [
        "pl",
        "de",
        "Nie było jej już w mieście, a on nie wiedział, gdzie teraz mieszka, więc czekał.",
        "Sie war nicht mehr in der Stadt, und er wusste nicht, wo sie jetzt wohnte, also wartete er.",
      ],
    ];
    for (const [from, to, source, text] of pairs) {
      const r = check(source, text, ctx(from, to));
      expect([from, to, r.errors, r.warnings]).toEqual([from, to, [], []]);
    }
  });
});
