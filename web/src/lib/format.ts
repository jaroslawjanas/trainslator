/** Display helpers. They change how text is shown, never the data. */

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);
const ROMAN = /^(?=[MDCLXVI])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

function capitalize(word: string): string {
  return word.replace(/\p{L}/u, (c) => c.toUpperCase());
}

/**
 * Titles as they should read in navigation: "THE STAR-CHILD" becomes
 * "The Star-Child", "Contents." loses its trailing full stop. Roman
 * numerals and titles in normal case are left alone.
 */
export function displayTitle(raw: string): string {
  let title = raw.trim().replace(/\s+/g, " ");
  if (/\.$/.test(title) && !/\.\S*\.$/.test(title)) title = title.slice(0, -1);
  const hasUpper = /\p{Lu}/u.test(title);
  const hasLower = /\p{Ll}/u.test(title);
  if (!hasUpper || hasLower) return title;
  return title
    .split(" ")
    .map((word, i) => {
      const bare = word.replace(/[.:,;]+$/, "");
      if (bare && ROMAN.test(bare)) return word;
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.split("-").map(capitalize).join("-");
    })
    .join(" ");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Like plural, but "no entries" for zero. */
export function count(n: number, one: string, many = `${one}s`): string {
  return n === 0 ? `no ${many}` : plural(n, one, many);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 minutes ago", "yesterday", or a date for anything older than a week. */
export function relativeTime(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return RELATIVE.format(Math.round(seconds / 86_400), "day");
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** "An English", "A German": a language name with its article, to start a sentence. */
export function withArticle(name: string): string {
  return `${/^[AEIOU]/.test(name) ? "An" : "A"} ${name}`;
}

/** Joins items into an English list: "a, b and c". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
