import type { Finding, StyleNote } from "../prompts/phase1.ts";
import type { KbKind, KbTreatment } from "../shared/schemas/kb.ts";
import { type KindFamily, kindFamily, normalizeKey } from "./model.ts";

/** Findings about the same thing (same family + normalized source) from all chapters. */
export interface FindingGroup {
  id: string;
  family: KindFamily;
  key: string;
  kinds: Record<string, number>;
  sources: Record<string, number>;
  /** Dictionary-form renderings with the units they were seen in. */
  targets: Record<string, string[]>;
  targetSeen: string[];
  treatments: Record<string, number>;
  attributes: Record<string, Record<string, number>>;
  notes: string[];
  quotes: { unit: string; source: string; target: string | null }[];
  units: string[];
}

export interface UnitFindings {
  unitId: string;
  findings: Finding[];
  styleNotes: StyleNote[];
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function top<T extends string>(map: Record<string, number>): T | null {
  let best: string | null = null;
  let n = -1;
  for (const [k, v] of Object.entries(map)) {
    if (v > n || (v === n && best !== null && k < best)) {
      best = k;
      n = v;
    }
  }
  return best as T | null;
}

export function groupFindings(units: UnitFindings[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const u of units) {
    for (const f of u.findings) {
      const key = normalizeKey(f.source);
      if (!key) continue;
      const family = kindFamily(f.kind);
      const gk = `${family}:${key}`;
      let g = groups.get(gk);
      if (!g) {
        g = {
          id: "",
          family,
          key,
          kinds: {},
          sources: {},
          targets: {},
          targetSeen: [],
          treatments: {},
          attributes: {},
          notes: [],
          quotes: [],
          units: [],
        };
        groups.set(gk, g);
      }
      bump(g.kinds, f.kind);
      bump(g.sources, f.source.trim());
      if (f.target?.trim()) {
        const t = f.target.trim();
        g.targets[t] = [...(g.targets[t] ?? []), u.unitId];
      }
      for (const s of f.targetSeen) {
        const t = s.trim();
        if (t && !g.targetSeen.includes(t) && !(t in g.targets) && g.targetSeen.length < 12)
          g.targetSeen.push(t);
      }
      if (f.treatment) bump(g.treatments, f.treatment);
      for (const a of f.attributes) {
        const k = a.key.trim().toLowerCase();
        if (!k || !a.value.trim()) continue;
        g.attributes[k] ??= {};
        bump(g.attributes[k], a.value.trim());
      }
      const note = f.note.trim();
      if (
        note &&
        g.notes.length < 8 &&
        !g.notes.some((n) => n.toLowerCase() === note.toLowerCase())
      )
        g.notes.push(note);
      if (
        f.sourceQuote.trim() &&
        g.quotes.length < 3 &&
        !g.quotes.some((q) => q.unit === u.unitId)
      ) {
        g.quotes.push({
          unit: u.unitId,
          source: f.sourceQuote.trim(),
          target: f.targetQuote?.trim() || null,
        });
      }
      if (!g.units.includes(u.unitId)) g.units.push(u.unitId);
    }
  }
  // Stable ids: names first, then by key.
  const list = [...groups.values()].sort(
    (a, b) => a.family.localeCompare(b.family) || a.key.localeCompare(b.key),
  );
  list.forEach((g, i) => {
    g.id = `g${i + 1}`;
  });
  return list;
}

export function groupKind(g: FindingGroup): KbKind {
  return top<KbKind>(g.kinds) ?? (g.family === "names" ? "named_thing" : "term");
}

export function groupSource(g: FindingGroup): string {
  return top(g.sources) ?? g.key;
}

export function groupTarget(g: FindingGroup): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [t, units] of Object.entries(g.targets)) {
    if (units.length > n) {
      best = t;
      n = units.length;
    }
  }
  return best;
}

export function groupTreatment(g: FindingGroup): KbTreatment | null {
  return top<KbTreatment>(g.treatments);
}

/** One line per group for the cached index used by every merge batch. */
export function groupIndexLine(g: FindingGroup): string {
  const targets = Object.entries(g.targets)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([t, u]) => `${t} ×${u.length}`)
    .join(", ");
  return `${g.id} [${groupKind(g)}] ${groupSource(g)} → ${targets || "?"} (in ${g.units.length} chapter${g.units.length === 1 ? "" : "s"})`;
}

/** Full detail for the batch being decided. */
export function groupDetail(g: FindingGroup): string {
  const lines = [groupIndexLine(g)];
  const variants = Object.keys(g.sources);
  if (variants.length > 1) lines.push(`  spellings: ${variants.join(", ")}`);
  if (g.targetSeen.length > 0) lines.push(`  other forms: ${g.targetSeen.join(", ")}`);
  const treatment = groupTreatment(g);
  if (treatment) lines.push(`  treatment: ${treatment}`);
  for (const [k, values] of Object.entries(g.attributes)) {
    lines.push(
      `  ${k}: ${Object.entries(values)
        .map(([v, n]) => (n > 1 ? `${v} ×${n}` : v))
        .join(" / ")}`,
    );
  }
  for (const n of g.notes.slice(0, 4)) lines.push(`  note: ${n}`);
  for (const q of g.quotes.slice(0, 2))
    lines.push(`  e.g. "${q.source}"${q.target ? ` → "${q.target}"` : ""}`);
  return lines.join("\n");
}

export interface StyleGroup {
  rule: string;
  count: number;
  example: { source: string; target: string } | null;
}

export function groupStyleNotes(units: UnitFindings[]): StyleGroup[] {
  const map = new Map<string, StyleGroup>();
  for (const u of units) {
    for (const s of u.styleNotes) {
      const key = normalizeKey(s.rule);
      if (!key) continue;
      const g = map.get(key) ?? { rule: s.rule.trim(), count: 0, example: null };
      g.count++;
      if (!g.example && s.sourceQuote.trim())
        g.example = { source: s.sourceQuote.trim(), target: s.targetQuote.trim() };
      map.set(key, g);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}
