import type { EntryDraft, MergeDecision, StyleOutput } from "../prompts/phase1.ts";
import { nowIso } from "../shared/schemas/common.ts";
import type { Kb, KbEntry, KbOverrides, StyleRule } from "../shared/schemas/kb.ts";
import {
  type FindingGroup,
  groupKind,
  groupSource,
  groupTarget,
  groupTreatment,
  top,
} from "./group.ts";
import { entryKeys, normalizeKey, slugId, uniqueId } from "./model.ts";
import { applyOverrides, deletedKeys } from "./overrides.ts";

export interface ResolvedEntry {
  root: FindingGroup;
  merged: FindingGroup[];
  draft: EntryDraft | null;
}

export interface Resolution {
  entries: ResolvedEntry[];
  /** Groups that turned out to be existing locked entries (keyed by entry id). */
  intoLocked: Map<string, FindingGroup[]>;
  dropped: FindingGroup[];
}

/**
 * Turns merge decisions into entries. Problems that span batches are fixed
 * here: merging into a dropped group makes the group its own entry, and
 * cycles are broken at the group seen in the most chapters.
 */
export function resolveDecisions(
  groups: FindingGroup[],
  decisions: Map<string, MergeDecision>,
  lockedPromptIds: Map<string, string>,
): Resolution {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parent = new Map<string, string>();
  const dropped = new Set<string>();
  for (const g of groups) {
    const d = decisions.get(g.id);
    if (!d) continue;
    if (d.action === "drop") dropped.add(g.id);
    else if (
      d.action === "merge_into" &&
      d.into &&
      d.into !== g.id &&
      (byId.has(d.into) || lockedPromptIds.has(d.into))
    ) {
      parent.set(g.id, d.into);
    }
  }
  // Merging into a dropped group: keep the group as its own entry.
  for (const [child, target] of [...parent]) if (dropped.has(target)) parent.delete(child);

  const rootOf = (id: string): string => {
    const seen = new Set<string>([id]);
    let cur = id;
    while (parent.has(cur)) {
      const next = parent.get(cur)!;
      if (seen.has(next)) {
        // Cycle: the most widespread group becomes the root.
        const members = [...seen]
          .map((s) => byId.get(s))
          .filter((g): g is FindingGroup => g !== undefined);
        const best = members.sort(
          (a, b) => b.units.length - a.units.length || a.id.localeCompare(b.id),
        )[0]!;
        parent.delete(best.id);
        return best.id;
      }
      seen.add(next);
      cur = next;
    }
    return cur;
  };

  const entries = new Map<string, ResolvedEntry>();
  const intoLocked = new Map<string, FindingGroup[]>();
  for (const g of groups) {
    if (dropped.has(g.id)) continue;
    const root = rootOf(g.id);
    if (lockedPromptIds.has(root)) {
      const entryId = lockedPromptIds.get(root)!;
      intoLocked.set(entryId, [...(intoLocked.get(entryId) ?? []), g]);
      continue;
    }
    const rootGroup = byId.get(root)!;
    let e = entries.get(root);
    if (!e) {
      const d = decisions.get(root);
      e = { root: rootGroup, merged: [], draft: d?.action === "entry" ? d.entry : null };
      entries.set(root, e);
    }
    if (g.id !== root) e.merged.push(g);
  }
  return {
    entries: [...entries.values()],
    intoLocked,
    dropped: groups.filter((g) => dropped.has(g.id)),
  };
}

function unitOrder(a: string, b: string): number {
  const na = Number(/\d+/.exec(a)?.[0] ?? 0);
  const nb = Number(/\d+/.exec(b)?.[0] ?? 0);
  return na - nb || a.localeCompare(b);
}

function mergedAttributes(groups: FindingGroup[]): { key: string; value: string }[] {
  const combined: Record<string, Record<string, number>> = {};
  for (const g of groups) {
    for (const [k, values] of Object.entries(g.attributes)) {
      combined[k] ??= {};
      for (const [v, n] of Object.entries(values)) combined[k][v] = (combined[k][v] ?? 0) + n;
    }
  }
  return Object.entries(combined)
    .map(([key, values]) => ({ key, value: top(values) ?? "" }))
    .filter((a) => a.value)
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function assembleKb(args: {
  scope: "pair" | "book";
  title: string;
  resolution: Resolution;
  style: StyleOutput | null;
  existing: Kb | null;
  overrides: KbOverrides;
  /** The source language the names and terms are in. */
  lang: string;
}): Kb {
  const { resolution, existing, overrides } = args;
  const deleted = deletedKeys(overrides);
  const taken = new Set<string>(Object.keys(overrides.entries));
  const existingByKey = new Map<string, KbEntry>();
  for (const e of existing?.entries ?? [])
    for (const k of entryKeys(e, args.lang)) if (!existingByKey.has(k)) existingByKey.set(k, e);

  const drafts = resolution.entries.map((r) => {
    const all = [r.root, ...r.merged];
    const d = r.draft;
    const source = d?.source?.trim() || groupSource(r.root);
    const spellings = new Set<string>();
    for (const g of all) for (const s of Object.keys(g.sources)) spellings.add(s);
    for (const a of d?.aliases ?? []) spellings.add(a.trim());
    const aliases = [...spellings]
      .filter((s) => s && normalizeKey(s, args.lang) !== normalizeKey(source, args.lang))
      .slice(0, 10);
    const target = d ? d.target : groupTarget(r.root);
    const targetsSeen = new Set<string>();
    for (const g of all) {
      for (const t of Object.keys(g.targets)) if (t !== target) targetsSeen.add(t);
      for (const t of g.targetSeen) if (t !== target) targetsSeen.add(t);
    }
    const quotes = all.flatMap((g) => g.quotes).slice(0, 3);
    const refs = [...new Set(all.flatMap((g) => g.units))].sort(unitOrder);
    return {
      kind: d?.kind ?? groupKind(r.root),
      source,
      aliases,
      target: target?.trim() || null,
      targetSeen: [...targetsSeen].slice(0, 12),
      treatment: d ? d.treatment : groupTreatment(r.root),
      attributes: d
        ? d.attributes.filter((a) => a.key.trim() && a.value.trim())
        : mergedAttributes(all),
      note: (d?.note ?? r.root.notes[0] ?? "").trim(),
      examples: quotes.map((q) => ({ source: q.source, target: q.target })),
      refs,
    };
  });

  const entries: KbEntry[] = [];
  const now = nowIso();
  for (const draft of drafts.sort((a, b) => a.source.localeCompare(b.source))) {
    const keys = [draft.source, ...draft.aliases].map((t) => normalizeKey(t, args.lang));
    if (keys.some((k) => deleted.has(k))) continue;
    const previous = keys.map((k) => existingByKey.get(k)).find((e) => e !== undefined);
    const id =
      previous && !taken.has(previous.id)
        ? previous.id
        : uniqueId(slugId("e", draft.source), taken);
    taken.add(id);
    entries.push({
      id,
      ...draft,
      status: "auto",
      question: null,
      origin: "phase1",
      updatedAt: now,
    });
  }

  const styleRules: StyleRule[] = (args.style?.rules ?? []).map((r, i) => ({
    id: `r${i + 1}`,
    rule: r.rule.trim(),
    examples: r.sourceExample ? [{ source: r.sourceExample, target: r.targetExample }] : [],
    status: "auto",
  }));

  const kb: Kb = { schemaVersion: 1, scope: args.scope, title: args.title, entries, styleRules };
  const withOverrides = applyOverrides(kb, overrides, args.lang);
  // Groups that matched locked entries add their chapters to the entry's refs.
  for (const [entryId, groups] of resolution.intoLocked) {
    const e = withOverrides.entries.find((x) => x.id === entryId);
    if (e) e.refs = [...new Set([...e.refs, ...groups.flatMap((g) => g.units)])].sort(unitOrder);
  }
  return withOverrides;
}
