import { estimateTokens } from "../llm/tokens.ts";
import type { Kb } from "../shared/schemas/kb.ts";
import type { RefKbMode } from "../shared/schemas/project.ts";
import { renderReferenceKbs } from "./render.ts";

export interface ReferenceSelection {
  text: string | null;
  mode: "all" | "relevant";
  tokens: number;
  entries: number;
  totalEntries: number;
}

function mentioned(term: string, lowerText: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < 2) return false;
  let from = 0;
  for (;;) {
    const i = lowerText.indexOf(t, from);
    if (i < 0) return false;
    const before = lowerText[i - 1];
    const after = lowerText[i + t.length];
    const boundary = (ch: string | undefined) => ch === undefined || !/[\p{L}\p{N}]/u.test(ch);
    if (boundary(before) && boundary(after)) return true;
    from = i + 1;
  }
}

/**
 * Picks the reference knowledge for a book: everything, or only entries whose
 * names/terms appear in the book (plus all style rules). "auto" uses
 * everything unless it would take more than ~35% of the smallest context window.
 */
export function selectReferenceKbs(
  refs: { title: string; kb: Kb }[],
  bookText: string,
  mode: RefKbMode,
  smallestContext: number,
): ReferenceSelection {
  const totalEntries = refs.reduce((s, r) => s + r.kb.entries.length, 0);
  if (refs.length === 0) return { text: null, mode: "all", tokens: 0, entries: 0, totalEntries: 0 };
  const allText = renderReferenceKbs(refs);
  const allTokens = estimateTokens(allText);
  const wantAll = mode === "all" || (mode === "auto" && allTokens <= smallestContext * 0.35);
  if (wantAll)
    return {
      text: allText || null,
      mode: "all",
      tokens: allTokens,
      entries: totalEntries,
      totalEntries,
    };
  const lower = bookText.toLowerCase();
  const relevant = refs.map((r) => ({
    title: r.title,
    kb: {
      ...r.kb,
      entries: r.kb.entries.filter((e) =>
        [e.source, ...e.aliases].some((t) => mentioned(t, lower)),
      ),
    },
  }));
  const text = renderReferenceKbs(relevant);
  return {
    text: text || null,
    mode: "relevant",
    tokens: estimateTokens(text),
    entries: relevant.reduce((s, r) => s + r.kb.entries.length, 0),
    totalEntries,
  };
}
