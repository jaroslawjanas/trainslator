import { describe, expect, it } from "vitest";
import { languageData } from "../languages/index.ts";
import { emptyKb, type KbEntry } from "../shared/schemas/kb.ts";
import { inflection, termPattern, textIndex } from "./match.ts";
import { computeRefs, entryKeys, normalizeKey } from "./model.ts";
import { selectReferenceKbs } from "./select.ts";

const de = languageData("de")!;
const pl = languageData("pl")!;

function finds(term: string, text: string, data = de): boolean {
  return termPattern(term, data)!.test(text);
}

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

  it("counts chapters where a name only appears inflected", () => {
    const texts = [
      { id: "s1", text: "Die Ritter des Ordens ritten los." },
      { id: "s2", text: "Niemand sprach." },
    ];
    expect(computeRefs(entry("Orden"), texts, "de")).toEqual(["s1"]);
    expect(computeRefs(entry("Orden"), texts, "en")).toEqual([]);
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

  it("leaves English to exact matching", () => {
    expect(inflection("en")).toBeNull();
    expect(inflection("de")).not.toBeNull();
  });
});
