import { describe, expect, it } from "vitest";
import { languageData } from "../languages/index.ts";
import { emptyKb, type KbEntry } from "../shared/schemas/kb.ts";
import { foldForMatching, inflection, termPattern, termVariants, textIndex } from "./match.ts";
import { computeRefs, entryKeys, normalizeKey } from "./model.ts";
import { selectReferenceKbs } from "./select.ts";

const de = languageData("de")!;
const pl = languageData("pl")!;

function finds(term: string, text: string, data = de): boolean {
  return termPattern(term, data)!.test(text);
}

const entry = (source: string, aliases: string[] = []): KbEntry => ({
  id: `e_${source}`,
  kind: "person",
  source,
  aliases,
  target: source,
  targetSeen: [],
  treatment: "kept",
  attributes: [],
  note: "",
  examples: [],
  refs: [],
  status: "auto",
  question: null,
  origin: "phase1",
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("German names in running text", () => {
  it("finds names and terms with their case endings", () => {
    expect(finds("Orden", "Die Ritter des Ordens ritten los.")).toBe(true);
    expect(finds("Schwarzer Turm", "Sie ritten zum Schwarzen Turm.")).toBe(true);
    expect(finds("Schwarzer Turm", "die Mauern des Schwarzen Turms")).toBe(true);
    expect(finds("Anna", "Annas Bruder wartete.")).toBe(true);
    expect(finds("Kapitän", "die Mütze des Kapitäns")).toBe(true);
  });

  it("still needs whole words", () => {
    expect(finds("Turm", "Die Turmuhr schlug zwölf.")).toBe(false);
    expect(finds("Orden", "Die Ordnung war wiederhergestellt.")).toBe(false);
  });

  it("ignores German articles in name keys", () => {
    expect(normalizeKey("der Kapitän", "de")).toBe(normalizeKey("Kapitän", "de"));
    expect(normalizeKey("Die Stadt", "de")).toBe("stadt");
    // English keeps its own articles only.
    expect(normalizeKey("der Kapitän", "en")).toBe("der kapitän");
    expect(normalizeKey("The Storm", "en")).toBe("storm");
    expect(entryKeys({ source: "Der Rat", aliases: ["Rat der Alten"] }, "de")).toEqual([
      "rat",
      "rat der alten",
    ]);
  });
});

describe("Polish names in running text", () => {
  it("finds names with endings and stem changes", () => {
    expect(finds("Mira", "Powiedział Mirze, że wróci.", pl)).toBe(true);
    expect(finds("Mira", "Nie było Miry w domu.", pl)).toBe(true);
    expect(finds("Kraków", "Wyjechali z Krakowa rano.", pl)).toBe(true);
    expect(finds("Kraków", "Mieszkali w Krakowie.", pl)).toBe(true);
    expect(finds("Marek", "Nie widziała Marka od lat.", pl)).toBe(true);
    expect(finds("Polska", "Wrócił do Polski, a potem był w Polsce.", pl)).toBe(true);
    expect(finds("Piotr", "Dała Piotrowi list; mówiła o Piotrze.", pl)).toBe(true);
    expect(finds("Michał", "Wszyscy czekali na Michała.", pl)).toBe(true);
    // Short words of a longer name change too: "gór-y", "kul-e".
    expect(finds("Biała Góra", "Wrócili spod Białej Góry.", pl)).toBe(true);
    expect(finds("Biała Góra", "Wrócili spod Białej Wieży.", pl)).toBe(false);
  });

  it("doesn't match a different name", () => {
    expect(finds("Mira", "Przyszedł Mirek.", pl)).toBe(false);
    expect(finds("Marek", "Kupił marchew.", pl)).toBe(false);
  });
});

describe("refs and the reference selection", () => {
  it("counts chapters where a name only appears inflected", () => {
    const texts = [
      { id: "s1", text: "Die Ritter des Ordens ritten los." },
      { id: "s2", text: "Niemand sprach." },
    ];
    expect(computeRefs(entry("Orden"), texts, "de")).toEqual(["s1"]);
    // French has no endings: names match as they are.
    expect(computeRefs(entry("Orden"), texts, "fr")).toEqual([]);
  });

  it("selects reference entries the book mentions in any form", () => {
    const kb = {
      ...emptyKb("pair", "Earlier"),
      entries: [entry("Mira"), entry("Kraków"), entry("Szara Czapla"), entry("Wenecja")],
    };
    const book = "Mira wyjechała z Krakowa. Statek Szarej Czapli czekał w porcie.";
    const selection = selectReferenceKbs([{ title: "Earlier", kb }], book, "relevant", 1e9, "pl");
    expect(selection.entries).toBe(3);
    expect(selection.text).not.toContain("Wenecja");
  });

  it("uses the fast word index with the same results as the pattern", () => {
    const text = "Die Ritter des Ordens ritten zum Schwarzen Turm, wo Annas Bruder wartete.";
    const has = textIndex(text, de);
    for (const term of ["Orden", "Schwarzer Turm", "Anna", "Turm", "Ritter", "Burg", "Weißer Turm"])
      expect([term, has(term)]).toEqual([term, termPattern(term, de)!.test(text)]);
  });

  it("matches exactly in languages without endings", () => {
    expect(inflection("fr")).toBeNull();
    expect(inflection("de")).not.toBeNull();
  });
});

describe("spelling that doesn't decide a match", () => {
  const en = languageData("en")!;
  const has = (term: string, text: string) => textIndex(text, en)(term);

  it("finds English names in the singular or plural", () => {
    expect(has("Klingons", "A Klingon ship waited.")).toBe(true);
    expect(has("Klingon", "Two Klingons waited.")).toBe(true);
    expect(has("party", "There were parties every night.")).toBe(true);
    expect(has("bronto burger", "He ordered two bronto burgers.")).toBe(true);
    expect(has("leviathan", "The leviathans swam past.")).toBe(true);
    // Still whole words, and possessives as before.
    expect(has("Bob", "Bob's ship.")).toBe(true);
    expect(has("Turm", "The Turmuhr struck.")).toBe(false);
  });

  it("treats curly and straight apostrophes, and dashes, as the same", () => {
    expect(has("Heaven's River", "They reached Heaven’s River at dawn.")).toBe(true);
    expect(has("Heaven’s River", "They reached Heaven's River at dawn.")).toBe(true);
    expect(has("ma'am", "“Yes, ma’am.”")).toBe(true);
    expect(has("Heaven-1", "The probe left Heaven‑1 behind.")).toBe(true);
    const fr = "Les chevaliers de L’Ordre attendaient.";
    expect(computeRefs({ source: "l'Ordre", aliases: [] }, [{ id: "s", text: fr }], "fr")).toEqual([
      "s",
    ]);
  });

  it("finds a name given with a leading article without it", () => {
    expect(termVariants("the Devil", "en")).toEqual(["the Devil", "Devil"]);
    expect(termVariants("The Others", "en")).toEqual(["The Others", "Others"]);
    expect(termVariants("Theodore", "en")).toEqual(["Theodore"]);
    expect(has("the Devil", "Speak of the devil.")).toBe(true);
    expect(has("the imperatives", "Those imperatives again.")).toBe(true);
    expect(has("the Devil", "Speak of the deviled eggs.")).toBe(false);
  });

  it("gives the same answers through the word index as through the full pattern", () => {
    const text =
      "“A flotilla?” Bob asked. Heaven’s River lay a thousand kilometers’ radius away; the Klingon " +
      "parties met at Whack-a-Mole Hall, with Irish whiskey, the Ancient Ones and a me-too protest.";
    const index = textIndex(text, en);
    const folded = foldForMatching(text);
    for (const term of [
      "A flotilla?",
      "Heaven's River",
      "a thousand kilometers' radius",
      "Klingon party",
      "Klingons",
      "Whack-a-Mole",
      "Whack-a-Mole Hall",
      "Irish whiskey",
      "the Ancient Ones",
      "Ancient Ones met",
      "a me-too",
      "me-too protest",
      "whiskey Irish",
      "River lay",
      "kilometers radius",
    ]) {
      const viaPattern = termVariants(term, "en").some((v) => termPattern(v, en)!.test(folded));
      expect([term, index(term)]).toEqual([term, viaPattern]);
    }
  });

  it("selects reference entries with any of these spellings", () => {
    const kb = {
      ...emptyKb("pair", "Earlier"),
      entries: [
        entry("Heaven's River"),
        entry("Klingons"),
        entry("the Devil"),
        entry("O'Neill cylinder"),
      ],
    };
    const book = "Heaven’s River was far. A Klingon laughed. The devil, he said.";
    const selection = selectReferenceKbs([{ title: "Earlier", kb }], book, "relevant", 1e9, "en");
    expect(selection.entries).toBe(3);
    expect(selection.text).not.toContain("O'Neill");
  });
});
