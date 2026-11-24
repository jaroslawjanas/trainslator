import { keyArticleRegex, type LanguageData, languageData } from "../languages/index.ts";

/**
 * Finding names and terms in running text when the language inflects them:
 * German "des Ordens" for "Orden", Polish "Mirze" for "Mira", "Krakowa" for
 * "Kraków". Each word of a term may take one of the language's endings,
 * after its own ending is taken off and its stem has changed the way the
 * language's alternations allow. Recall matters more than precision here:
 * a missed name drops knowledge the translation needs, a false match only
 * sends an entry that wasn't needed.
 *
 * Languages without endings match names exactly. Every language ignores how
 * apostrophes and dashes are typed, and finds a name given with a leading
 * article ("the Devil") without it too.
 */

/**
 * Spelling that shouldn't decide whether a name matches: curly and straight
 * apostrophes, the various dashes, composed and decomposed accents.
 */
export function foldForMatching(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’ʼ`´′]/g, "'")
    .replace(/[‐‑‒–—―]/g, "-");
}

/** A term as it is matched, and without a leading article when it has one. */
export function termVariants(term: string, lang: string): string[] {
  const t = foldForMatching(term.trim());
  const article = keyArticleRegex(lang);
  if (!article) return [t];
  const bare = t.replace(new RegExp(article.source, "i"), "").trim();
  return bare !== t && bare.length >= 2 ? [t, bare] : [t];
}

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

/**
 * The words of a term with their forms. A one-word name, or a word of a longer
 * term (whose words must all follow each other), may lose more of its stem:
 * "Crna kula" is found as "Crne kule", "Biała Góra" as "Białej Góry".
 */
function termWords(term: string, data: LanguageData): string[][] {
  const words = term.trim().split(/\s+/).filter(Boolean);
  const loose = words.length > 1 || /^\p{Lu}/u.test(words[0] ?? "");
  return words.map((w) => wordForms(w, data, loose ? 3 : 4));
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
  const folded = foldForMatching(text);
  return terms.some((term) =>
    termVariants(term, data.tag).some((t) => termPattern(t, data)?.test(folded) ?? false),
  );
}

/**
 * For checking many terms against one long text (a whole book): the text's
 * words, and the pairs of words that follow each other with only spaces
 * between them, are collected once. A term is looked up in those sets, and
 * tested with a pattern over the whole text only when the sets can't decide.
 */
export function textIndex(text: string, data: LanguageData): (term: string) => boolean {
  const folded = foldForMatching(text);
  const lower = folded.toLowerCase();
  const words = new Set<string>();
  const pairs = new Set<string>();
  let previous: { word: string; end: number } | null = null;
  for (const m of lower.matchAll(/[\p{L}\p{N}]+/gu)) {
    words.add(m[0]);
    if (previous && /^\s+$/.test(lower.slice(previous.end, m.index)))
      pairs.add(`${previous.word} ${m[0]}`);
    previous = { word: m[0], end: m.index + m[0].length };
  }
  const anyPair = (a: string[], b: string[]) =>
    a.some((x) => b.some((y) => pairs.has(`${x} ${y}`)));
  const has = (t: string): boolean => {
    if (t.length < 2) return false;
    const forms = termWords(t, data);
    if (forms.length === 0) return false;
    // Every word must occur: in one of its forms, or as it is when it holds an
    // apostrophe or a hyphen (then each of its parts must).
    const occurs = forms.every((f) =>
      f.some((w) =>
        LETTERS.test(w)
          ? words.has(w)
          : (w.match(/[\p{L}\p{N}]+/gu) ?? []).every((p) => words.has(p)),
      ),
    );
    if (!occurs) return false;
    // Neighbouring words of the term must be neighbours somewhere in the text.
    // A word with an apostrophe or hyphen meets its neighbour with its first or
    // last part; with punctuation at that edge there's nothing to check.
    const edge = (f: string[], last: boolean): string[] | null => {
      if (f.every((w) => LETTERS.test(w))) return f;
      const w = f[0]!;
      const parts = w.match(/[\p{L}\p{N}]+/gu) ?? [];
      const atEdge = last ? /[\p{L}\p{N}]$/u.test(w) : /^[\p{L}\p{N}]/u.test(w);
      return atEdge && parts.length > 0 ? [last ? parts.at(-1)! : parts[0]!] : null;
    };
    for (let i = 1; i < forms.length; i++) {
      const a = edge(forms[i - 1]!, true);
      const b = edge(forms[i]!, false);
      if (a && b && !anyPair(a, b)) return false;
    }
    const simple = forms.every((f) => f.every((w) => LETTERS.test(w)));
    if (simple && forms.length <= 2) return true;
    return termPattern(t, data)?.test(folded) ?? false;
  };
  return (term) => termVariants(term, data.tag).some(has);
}
