/**
 * Language helpers. Everything here is data-driven (Intl + Unicode scripts);
 * there are no rules for specific languages.
 */

/** Common target languages offered in the picker. Any other BCP-47 tag can be typed in. */
export const COMMON_LANGUAGES: readonly string[] = [
  "af",
  "am",
  "ar",
  "az",
  "be",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "eo",
  "es",
  "es-419",
  "et",
  "eu",
  "fa",
  "fi",
  "fil",
  "fr",
  "fr-CA",
  "ga",
  "gl",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "ky",
  "lb",
  "lo",
  "lt",
  "lv",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "mt",
  "my",
  "nb",
  "ne",
  "nl",
  "nn",
  "pa",
  "pl",
  "pt",
  "pt-BR",
  "pt-PT",
  "ro",
  "ru",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "sr-Latn",
  "sv",
  "sw",
  "ta",
  "te",
  "tg",
  "th",
  "tk",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "yi",
  "zh-Hans",
  "zh-Hant",
  "zu",
];

/** Canonical form of a BCP-47 tag, or null if it isn't valid. */
export function canonicalLanguageTag(tag: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag.trim());
    return canonical ?? null;
  } catch {
    return null;
  }
}

export function languageDisplayName(tag: string, inLanguage = "en"): string {
  try {
    return new Intl.DisplayNames([inLanguage], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** Primary language subtag, lowercased: "en-US" → "en". */
export function primarySubtag(tag: string): string {
  return tag.split(/[-_]/)[0]?.toLowerCase() ?? "";
}

/** ISO 15924 script of a language tag ("pl" → "Latn", "zh-Hant" → "Hant"), or null. */
export function scriptOf(tag: string): string | null {
  try {
    return new Intl.Locale(tag).maximize().script ?? null;
  } catch {
    return null;
  }
}

const RTL_SCRIPTS = new Set([
  "Arab",
  "Hebr",
  "Thaa",
  "Syrc",
  "Nkoo",
  "Adlm",
  "Rohg",
  "Mand",
  "Samr",
  "Yezi",
  "Mend",
]);

interface TextInfoLocale {
  getTextInfo?: () => { direction?: string };
  textInfo?: { direction?: string };
}

/** Writing direction of a language. Uses Intl when available, else the script. */
export function directionOf(tag: string): "ltr" | "rtl" {
  try {
    const locale = new Intl.Locale(tag) as unknown as TextInfoLocale;
    const info = typeof locale.getTextInfo === "function" ? locale.getTextInfo() : locale.textInfo;
    if (info?.direction === "rtl" || info?.direction === "ltr") return info.direction;
  } catch {
    // fall through to the script check
  }
  const script = scriptOf(tag);
  return script && RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
}

/**
 * Unicode script property values used to check that text is in the target script.
 * Script codes that aren't Unicode script values (Hans, Jpan, …) map to the scripts they combine.
 */
export function unicodeScriptsFor(script: string | null): string[] {
  if (!script) return [];
  const combined: Record<string, string[]> = {
    Hans: ["Hani"],
    Hant: ["Hani"],
    Jpan: ["Hani", "Hira", "Kana"],
    Kore: ["Hang", "Hani"],
    Hanb: ["Hani", "Bopo"],
  };
  const candidates = combined[script] ?? [script];
  return candidates.filter((s) => {
    try {
      new RegExp(`\\p{Script=${s}}`, "u");
      return true;
    } catch {
      return false;
    }
  });
}

/** Share (0–1) of letters in `text` that belong to one of `scripts`. Null when there are no letters. */
export function scriptShare(text: string, scripts: string[]): number | null {
  if (scripts.length === 0) return null;
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return null;
  const re = new RegExp(`[${scripts.map((s) => `\\p{Script=${s}}`).join("")}]`, "u");
  let hits = 0;
  for (const ch of letters) if (re.test(ch)) hits++;
  return hits / letters.length;
}

/** Count words with Intl.Segmenter, so languages without spaces are counted sensibly. */
export function countWords(text: string, lang: string): number {
  if (!text.trim()) return 0;
  try {
    const segmenter = new Intl.Segmenter(lang, { granularity: "word" });
    let n = 0;
    for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
    return n;
  } catch {
    return text.split(/\s+/).filter(Boolean).length;
  }
}
