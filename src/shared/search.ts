/**
 * Text search that by default ignores case and accents: "zrodlo" finds
 * "Źródło", "ł" counts as "l" and "ß" as "ss". Shared by the server's search and replace
 * and the page's highlighting, so all find the same places.
 */

export interface MatchOptions {
  /** Case and accents must match exactly. */
  exact?: boolean;
  /** Only whole words: no letter or digit right before or after. */
  wholeWord?: boolean;
}

/**
 * The text folded for comparing, and where each folded character came from
 * (its original character starts at `at` and ends at `end`; "ß" becomes two).
 */
function fold(text: string): { folded: string; at: number[]; end: number[] } {
  let folded = "";
  const at: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const f = ch
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/ł/g, "l")
      .replace(/ß/g, "ss");
    for (let k = 0; k < f.length; k++) {
      folded += f[k];
      at.push(i);
      end.push(i + ch.length);
    }
    i += ch.length;
  }
  return { folded, at, end };
}

/** The query as it is compared; empty when there's nothing to search for. */
export function foldQuery(query: string): string {
  return fold(query.trim()).folded;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const code = text.codePointAt(index)!;
  return WORD_CHAR.test(String.fromCodePoint(code));
}

/** The character before `index`, which may be the low half of a surrogate pair. */
function charBefore(text: string, index: number): number {
  if (index <= 0) return -1;
  const low = text.charCodeAt(index - 1);
  return low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
}

/** Where the query occurs in the text, as ranges of the original text. */
export function findMatches(
  text: string,
  query: string,
  options: MatchOptions = {},
): { start: number; end: number }[] {
  const trimmed = query.trim();
  let found: { start: number; end: number }[] = [];
  if (options.exact) {
    if (!trimmed) return [];
    for (let i = text.indexOf(trimmed); i >= 0; i = text.indexOf(trimmed, i + trimmed.length))
      found.push({ start: i, end: i + trimmed.length });
  } else {
    const q = foldQuery(trimmed);
    if (!q) return [];
    const { folded, at, end } = fold(text);
    for (let i = folded.indexOf(q); i >= 0; i = folded.indexOf(q, i + q.length)) {
      const after = i + q.length;
      // A match that ends inside "ß" ("stras" in "Straße") covers all of it.
      const next = after < at.length ? at[after]! : text.length;
      found.push({ start: at[i]!, end: Math.max(end[after - 1]!, next) });
    }
  }
  if (options.wholeWord)
    found = found.filter(
      (m) => !isWordChar(text, charBefore(text, m.start)) && !isWordChar(text, m.end),
    );
  return found;
}
