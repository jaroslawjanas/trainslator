import { z } from "zod";
import { languageDisplayName, primarySubtag } from "../shared/languages.ts";
import bg from "./bg.json" with { type: "json" };
import ca from "./ca.json" with { type: "json" };
import cs from "./cs.json" with { type: "json" };
import da from "./da.json" with { type: "json" };
import de from "./de.json" with { type: "json" };
import el from "./el.json" with { type: "json" };
import en from "./en.json" with { type: "json" };
import es from "./es.json" with { type: "json" };
import fil from "./fil.json" with { type: "json" };
import fr from "./fr.json" with { type: "json" };
import hr from "./hr.json" with { type: "json" };
import id from "./id.json" with { type: "json" };
import it from "./it.json" with { type: "json" };
import ms from "./ms.json" with { type: "json" };
import nb from "./nb.json" with { type: "json" };
import nl from "./nl.json" with { type: "json" };
import pl from "./pl.json" with { type: "json" };
import pt from "./pt.json" with { type: "json" };
import ro from "./ro.json" with { type: "json" };
import ru from "./ru.json" with { type: "json" };
import sk from "./sk.json" with { type: "json" };
import sl from "./sl.json" with { type: "json" };
import sr from "./sr.json" with { type: "json" };
import sv from "./sv.json" with { type: "json" };
import uk from "./uk.json" with { type: "json" };

/**
 * Words of a language that the code needs: articles to ignore in names,
 * endings names take in running text, front- and back-matter titles,
 * chapter and number words, common words and preambles. No instructions:
 * prompts stay in English and only name the language.
 *
 * A language without a file still works, without these guesses.
 */

const Words = z.array(z.string().min(1));

export const LanguageData = z.strictObject({
  $schema: z.string().optional(),
  tag: z.string().min(2),
  article: z
    .enum(["a", "an"])
    .describe('English article before the language\'s name: "an English book", "a German book".'),
  keyArticles: Words.optional().describe(
    "Articles ignored at the start of names and terms when entries are matched. An article ending in an apostrophe (French l') may be joined to the word. Keys of your own changes are stored with them, so changing the list changes which entries count as the same.",
  ),
  endings: Words.optional().describe(
    "Endings a name or term may take in running text (German: s, en; Polish: a, owi …).",
  ),
  alternations: z
    .array(z.tuple([z.string().min(1), z.string().min(1)]))
    .optional()
    .describe('Stem changes before an ending: ["r", "rz"] lets Piotr match Piotrze.'),
  commonWords: Words.optional().describe(
    "Very common function words, used to notice text left untranslated in this language.",
  ),
  frontMatter: Words.optional().describe(
    "Title words of front matter; a trailing * matches any ending.",
  ),
  backMatter: Words.optional().describe(
    "Title words of back matter; a trailing * matches any ending.",
  ),
  chapterWords: Words.optional().describe(
    'Words like "chapter" or "part" that come with a number.',
  ),
  numberWords: z.record(z.string(), z.number().int()).optional(),
  ordinals: z
    .record(z.string(), z.number().int())
    .optional()
    .describe("Ordinals, or ordinal stems the language's endings may follow."),
  preambles: Words.optional().describe(
    "Phrases a model may start an answer with instead of the translation, in this language.",
  ),
  translationWords: Words.optional().describe(
    'Stems of the word for "translation" (übersetz, tłumacz): an answer that starts like a preamble and mentions one is taken for a preamble.',
  ),
  notes: z.string().optional(),
});
export type LanguageData = z.infer<typeof LanguageData>;

const FILES: Record<string, LanguageData> = Object.fromEntries(
  [
    en,
    de,
    pl,
    bg,
    ca,
    cs,
    da,
    el,
    es,
    fil,
    fr,
    hr,
    id,
    it,
    ms,
    nb,
    nl,
    pt,
    ro,
    ru,
    sk,
    sl,
    sr,
    sv,
    uk,
  ].map((file) => {
    const data = LanguageData.parse(file);
    return [data.tag, data];
  }),
);

/** The languages books can be translated from: every language with a file, English first. */
export const SOURCE_LANGUAGES: readonly string[] = [
  "en",
  ...Object.keys(FILES)
    .filter((tag) => tag !== "en")
    .sort((a, b) => languageDisplayName(a).localeCompare(languageDisplayName(b), "en")),
];

/** A language's word data, by its primary subtag ("de-AT" uses de.json), or null. */
export function languageData(tag: string): LanguageData | null {
  return FILES[primarySubtag(tag)] ?? null;
}

/** All bundled language files (for tests and the schema). */
export function allLanguageData(): LanguageData[] {
  return Object.values(FILES);
}

export interface SourceLanguage {
  tag: string;
  /** English name, as the prompts use it: "German". */
  name: string;
  /** "a" or "an", for "a German novel". */
  article: "a" | "an";
}

export function sourceLanguage(tag: string): SourceLanguage {
  const name = languageDisplayName(tag);
  return {
    tag,
    name,
    article: languageData(tag)?.article ?? (/^[aeiou]/i.test(name) ? "an" : "a"),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ASCII = /^[\x20-\x7e]*$/;

/**
 * Case-insensitive whole-word matcher for title words. Lists of plain ASCII
 * words (English) use \b like before; others use Unicode-aware boundaries so
 * "Über" or "Spis treści" are whole words too. A trailing * means any ending.
 */
export function wordListMatcher(words: readonly string[]): RegExp | null {
  if (words.length === 0) return null;
  const ascii = words.every((w) => ASCII.test(w));
  const any = ascii ? "\\w*" : "\\p{L}*";
  const alternatives = words
    .map((w) => (w.endsWith("*") ? `${escapeRegExp(w.slice(0, -1))}${any}` : escapeRegExp(w)))
    .join("|");
  return ascii
    ? new RegExp(`\\b(${alternatives})\\b`, "i")
    : new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives})(?![\\p{L}\\p{N}])`, "iu");
}

const memo = new Map<string, unknown>();
function memoized<T>(key: string, make: () => T): T {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as T;
}

/** Front- and back-matter title matchers for a language (null without a file). */
export function matterMatchers(tag: string): { front: RegExp | null; back: RegExp | null } {
  const data = languageData(tag);
  return memoized(`matter:${data?.tag ?? ""}`, () => ({
    front: wordListMatcher(data?.frontMatter ?? []),
    back: wordListMatcher(data?.backMatter ?? []),
  }));
}

/**
 * The leading-article pattern for name keys, on lowercased text (null: none).
 * Articles ending in an apostrophe ("l'") may be joined to the word.
 */
export function keyArticleRegex(tag: string): RegExp | null {
  const data = languageData(tag);
  return memoized(`articles:${data?.tag ?? ""}`, () => {
    const articles = data?.keyArticles ?? [];
    const spaced = articles.filter((a) => !a.endsWith("'")).map(escapeRegExp);
    const joined = articles.filter((a) => a.endsWith("'")).map(escapeRegExp);
    if (joined.length === 0)
      return spaced.length > 0 ? new RegExp(`^(${spaced.join("|")})\\s+`) : null;
    if (spaced.length === 0) return new RegExp(`^(${joined.join("|")})\\s*`);
    return new RegExp(`^(?:(${spaced.join("|")})\\s+|(${joined.join("|")})\\s*)`);
  });
}
