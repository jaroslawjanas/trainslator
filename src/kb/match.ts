import { type LanguageData, languageData } from "../languages/index.ts";

/**
 * Finding names and terms in running text when the language inflects them:
 * German "des Ordens" for "Orden", Polish "Mirze" for "Mira", "Krakowa" for
 * "Kraków". Each word of a term may take one of the language's endings,
 * after its own ending is taken off and its stem has changed the way the
 * language's alternations allow. Recall matters more than precision here:
 * a missed name drops knowledge the translation needs, a false match only
 * sends an entry that wasn't needed.
 *
 * Languages without endings (English) don't use this; their matching stays
 * exactly as it was.
 */

/** Data for inflection-aware matching, or null when the language matches names exactly. */
export function inflection(lang: string): LanguageData | null {
  const data = languageData(lang);
  return data && (data.endings?.length ?? 0) > 0 ? data : null;
}

const LETTERS = /^[\p{L}\p{N}]+$/u;

/** All lowercase forms a word of a term may take in text. */
export function wordForms(word: string, data: LanguageData, minStem: number): string[] {
  const w = word.toLowerCase();
  if (w.length < 3 || !LETTERS.test(w)) return [w];
  const endings = data.endings ?? [];
  const stems = new Set<string>([w]);
  for (const ending of [...endings].sort((a, b) => b.length - a.length)) {
    if (w.endsWith(ending) && w.length - ending.length >= minStem) {
      stems.add(w.slice(0, -ending.length));
      break;
    }
  }
  for (const stem of [...stems]) {
    for (const [from, to] of data.alternations ?? []) {
      // Stem changes happen near the end of the stem: Piotr → Piotrz-e, Kraków → Krakow-a.
      const at = stem.lastIndexOf(from);
      if (at >= 0 && at >= stem.length - from.length - 2)
        stems.add(stem.slice(0, at) + to + stem.slice(at + from.length));
    }
  }
  const forms = new Set<string>();
  for (const stem of stems) {
    forms.add(stem);
    for (const ending of endings) forms.add(stem + ending);
  }
  forms.delete("");
  return [...forms];
}

/** The words of a term with their forms. A one-word name may lose more of its stem. */
function termWords(term: string, data: LanguageData): string[][] {
  const words = term.trim().split(/\s+/).filter(Boolean);
  const name = words.length === 1 && /^\p{Lu}/u.test(words[0]!);
  return words.map((w) => wordForms(w, data, name ? 3 : 4));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-word, case-insensitive pattern for a term in any of its forms. */
export function termPattern(term: string, data: LanguageData): RegExp | null {
  const words = termWords(term, data);
  if (words.length === 0 || term.trim().length < 2) return null;
  const parts = words.map(
    (forms) =>
      `(?:${[...forms]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join("|")})`,
  );
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
}

/** Whether any of the terms occurs in the text, in any of its forms. */
export function mentionsAny(terms: string[], text: string, data: LanguageData): boolean {
  return terms.some((t) => termPattern(t, data)?.test(text) ?? false);
}

/**
 * For checking many terms against one long text (a whole book): the text's
 * words are collected once, one-word terms are looked up in that set, and
 * only terms of several words that could match are tested with a pattern.
 */
export function textIndex(text: string, data: LanguageData): (term: string) => boolean {
  const words = new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[]);
  return (term) => {
    const t = term.trim();
    if (t.length < 2) return false;
    const forms = termWords(t, data);
    if (forms.length === 0) return false;
    const simple = forms.every((f) => f.every((w) => LETTERS.test(w)));
    if (!simple) return termPattern(t, data)?.test(text) ?? false;
    if (!forms.every((f) => f.some((w) => words.has(w)))) return false;
    return forms.length === 1 || (termPattern(t, data)?.test(text) ?? false);
  };
}
