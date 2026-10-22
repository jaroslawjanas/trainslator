import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allLanguageData,
  keyArticleRegex,
  LanguageData,
  languageData,
  matterMatchers,
  SOURCE_LANGUAGES,
  sourceLanguage,
} from "./index.ts";

// The English rules before they moved into en.json.
const OLD_FRONT =
  /\b(contents|table of contents|copyright|title page|half[- ]title|dedication|epigraph|cover|praise for|about the publisher|imprint|colophon|frontispiece|series page)\b/i;
const OLD_BACK =
  /\b(about the authors?|acknowledg\w*|also by|end ?notes|notes|glossary|index|bibliography|credits|newsletter|sneak peek|excerpt|reading group|discussion questions|about the type|licen[cs]e)\b/i;

const TITLES = [
  "Contents",
  "Table of Contents",
  "Copyright Page",
  "Title page",
  "Half-Title",
  "Half Title",
  "Halftitle",
  "Dedication",
  "Epigraph",
  "Cover",
  "Covered",
  "Praise for Jane",
  "About the Publisher",
  "Imprint",
  "Colophon",
  "Frontispiece",
  "Series Page",
  "About the Author",
  "About the Authors",
  "About the Authorial Voice",
  "Acknowledgements",
  "Acknowledgments",
  "Acknowledge",
  "Also by Jane",
  "Endnotes",
  "End Notes",
  "End  Notes",
  "Notes",
  "Notebook",
  "The Notes of Mr. Hale",
  "Glossary",
  "Index",
  "Indexed",
  "Bibliography",
  "Credits",
  "Newsletter",
  "Sneak Peek",
  "Excerpt",
  "Reading Group Guide",
  "Discussion Questions",
  "About the Type",
  "Licence",
  "License",
  "Licensed",
  "Chapter One",
  "Prologue",
  "notes_1",
  "Notesé",
  "",
];

describe("language files", () => {
  it("parse, and the schema file matches the zod schema", () => {
    expect(
      allLanguageData()
        .map((d) => d.tag)
        .sort(),
    ).toEqual(
      "bg ca cs da de el en es fil fr hr id it ms nb nl pl pt ro ru sk sl sr sv uk".split(" "),
    );
    const file = JSON.parse(
      readFileSync(new URL("./language.schema.json", import.meta.url), "utf8"),
    );
    expect(file).toEqual(z.toJSONSchema(LanguageData));
  });

  it("offer every language with a file as a source, English first", () => {
    expect(
      SOURCE_LANGUAGES.map((t) => `${sourceLanguage(t).article} ${sourceLanguage(t).name}`),
    ).toEqual([
      "an English",
      "a Bulgarian",
      "a Catalan",
      "a Croatian",
      "a Czech",
      "a Danish",
      "a Dutch",
      "a Filipino",
      "a French",
      "a German",
      "a Greek",
      "an Indonesian",
      "an Italian",
      "a Malay",
      "a Norwegian Bokmål",
      "a Polish",
      "a Portuguese",
      "a Romanian",
      "a Russian",
      "a Serbian",
      "a Slovak",
      "a Slovenian",
      "a Spanish",
      "a Swedish",
      "a Ukrainian",
    ]);
    expect(sourceLanguage("de")).toEqual({ tag: "de", name: "German", article: "a" });
    expect(languageData("de-AT")?.tag).toBe("de");
    expect(languageData("sr-Latn")?.tag).toBe("sr");
    expect(languageData("fi")).toBeNull();
  });

  it("keep English front and back matter exactly as before", () => {
    const { front, back } = matterMatchers("en");
    for (const title of TITLES) {
      expect([title, front!.test(title)]).toEqual([title, OLD_FRONT.test(title)]);
      expect([title, back!.test(title)]).toEqual([title, OLD_BACK.test(title)]);
    }
  });

  it("keep English name keys exactly as before", () => {
    expect(keyArticleRegex("en")!.source).toBe("^(the|a|an)\\s+");
    expect(keyArticleRegex("pl")).toBeNull();
  });

  it("let articles ending in an apostrophe join the word", () => {
    const fr = keyArticleRegex("fr")!;
    expect("l'ordre".replace(fr, "")).toBe("ordre");
    expect("l' ordre".replace(fr, "")).toBe("ordre");
    expect("le chevalier".replace(fr, "")).toBe("chevalier");
    expect("lequel".replace(fr, "")).toBe("lequel");
  });

  it("pin German articles: keys of your own changes are stored with them", () => {
    expect(languageData("de")!.keyArticles).toEqual([
      "der",
      "die",
      "das",
      "den",
      "dem",
      "des",
      "ein",
      "eine",
      "einen",
      "einem",
      "einer",
      "eines",
    ]);
  });

  it("match German and Polish titles as whole words", () => {
    const de = matterMatchers("de");
    expect(de.front!.test("Inhaltsverzeichnis")).toBe(true);
    expect(de.front!.test("Inhalte der Welt")).toBe(false);
    expect(de.back!.test("Über die Autorin")).toBe(true);
    expect(de.back!.test("Danksagung")).toBe(true);
    const pl = matterMatchers("pl");
    expect(pl.front!.test("Spis treści")).toBe(true);
    expect(pl.back!.test("Podziękowania")).toBe(true);
    expect(pl.back!.test("Przypisy tłumacza")).toBe(true);
    expect(pl.front!.test("Rozdział pierwszy")).toBe(false);
  });
});
