import { z } from "zod";
import { languageDisplayName, primarySubtag } from "../shared/languages.ts";
import de from "./de.json" with { type: "json" };
import en from "./en.json" with { type: "json" };
import pl from "./pl.json" with { type: "json" };

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
    "Articles ignored at the start of names and terms when entries are matched. Keys of your own changes are stored with them, so changing the list changes which entries count as the same.",
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
  notes: z.string().optional(),
});
export type LanguageData = z.infer<typeof LanguageData>;

const FILES: Record<string, LanguageData> = Object.fromEntries(
  [en, de, pl].map((file) => {
    const data = LanguageData.parse(file);
    return [data.tag, data];
  }),
);

/** The languages books can be translated from. */
export const SOURCE_LANGUAGES: readonly string[] = ["en", "de", "pl"];

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

/** The leading-article pattern for name keys, on lowercased text (null: none). */
export function keyArticleRegex(tag: string): RegExp | null {
  const data = languageData(tag);
  return memoized(`articles:${data?.tag ?? ""}`, () => {
    const articles = data?.keyArticles ?? [];
    return articles.length > 0
      ? new RegExp(`^(${articles.map(escapeRegExp).join("|")})\\s+`)
      : null;
  });
}
