import { createHash } from "node:crypto";
import type { KbEntry, KbKind } from "../shared/schemas/kb.ts";

export type KindFamily = "names" | "expressions";

export function kindFamily(kind: KbKind): KindFamily {
  return kind === "person" || kind === "place" || kind === "organization" || kind === "named_thing"
    ? "names"
    : "expressions";
}

/** Normalized form used to match the same name or term across chapters and runs. */
export function normalizeKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/^[\s"'([{.,;:!?*_-]+|[\s"')\]}.,;:!?*_-]+$/g, "")
    .replace(/^(the|a|an)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** All normalized keys an entry answers to (source and aliases). */
export function entryKeys(entry: Pick<KbEntry, "source" | "aliases">): string[] {
  return [entry.source, ...entry.aliases].map(normalizeKey).filter(Boolean);
}

/** A readable, stable id from the source text: "e_old_mags". */
export function slugId(prefix: string, text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (slug) return `${prefix}_${slug}`;
  return `${prefix}_${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}

/** Ids not yet in `taken`: adds -2, -3 … on collisions. */
export function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`.slice(-64);
  taken.add(id);
  return id;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where an entry's source or aliases occur, as unit/segment ids. */
export function computeRefs(
  entry: Pick<KbEntry, "source" | "aliases">,
  texts: { id: string; text: string }[],
): string[] {
  const terms = [entry.source, ...entry.aliases].map((t) => t.trim()).filter((t) => t.length >= 2);
  if (terms.length === 0) return [];
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${terms.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
    "iu",
  );
  return texts.filter((t) => pattern.test(t.text)).map((t) => t.id);
}
