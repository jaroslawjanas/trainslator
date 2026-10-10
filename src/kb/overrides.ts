import { nowIso } from "../shared/schemas/common.ts";
import type { Kb, KbEntry, KbOverrides, StyleRule } from "../shared/schemas/kb.ts";
import { entryKeys, normalizeKey } from "./model.ts";

/**
 * Your edits to a KB are stored separately (kb.overrides.json) and replayed
 * after every automatic rebuild, so re-running a phase never undoes them.
 */

function findIndex(entries: KbEntry[], id: string, key: string): number {
  const byId = entries.findIndex((e) => e.id === id);
  if (byId >= 0) return byId;
  return key ? entries.findIndex((e) => entryKeys(e).includes(key)) : -1;
}

export function applyOverrides(kb: Kb, overrides: KbOverrides): Kb {
  const entries = [...kb.entries];
  for (const [id, o] of Object.entries(overrides.entries)) {
    const i = findIndex(entries, id, o.key);
    if (o.entry === null) {
      if (i >= 0) entries.splice(i, 1);
      continue;
    }
    if (i >= 0) {
      // Keep code-computed refs from the rebuild; everything else is yours.
      entries[i] = {
        ...o.entry,
        refs: entries[i]!.refs.length > 0 ? entries[i]!.refs : o.entry.refs,
      };
    } else {
      entries.push(o.entry);
    }
  }
  // An entry matched by key may have had a different id; drop duplicates of overridden keys.
  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  const rules = [...kb.styleRules];
  for (const [id, o] of Object.entries(overrides.styleRules)) {
    const i = rules.findIndex((r) => r.id === id);
    if (o.rule === null) {
      if (i >= 0) rules.splice(i, 1);
    } else if (i >= 0) rules[i] = o.rule;
    else rules.push(o.rule);
  }
  return { ...kb, entries: deduped, styleRules: rules };
}

/** Normalized keys you deleted; automatic steps must not add them again. */
export function deletedKeys(overrides: KbOverrides): Set<string> {
  return new Set(
    Object.values(overrides.entries)
      .filter((o) => o.entry === null)
      .map((o) => o.key),
  );
}

export function lockEntry(overrides: KbOverrides, entry: KbEntry): KbOverrides {
  const locked: KbEntry = {
    ...entry,
    status: entry.status === "open" ? "locked" : "locked",
    updatedAt: nowIso(),
  };
  return {
    ...overrides,
    entries: {
      ...overrides.entries,
      [entry.id]: { key: normalizeKey(entry.source), entry: locked, at: nowIso() },
    },
  };
}

export function unlockEntry(overrides: KbOverrides, id: string): KbOverrides {
  const { [id]: _removed, ...rest } = overrides.entries;
  return { ...overrides, entries: rest };
}

export function deleteEntry(overrides: KbOverrides, entry: KbEntry): KbOverrides {
  return {
    ...overrides,
    entries: {
      ...overrides.entries,
      [entry.id]: { key: normalizeKey(entry.source), entry: null, at: nowIso() },
    },
  };
}

export function setStyleRule(
  overrides: KbOverrides,
  rule: StyleRule | null,
  id: string,
): KbOverrides {
  return {
    ...overrides,
    styleRules: {
      ...overrides.styleRules,
      [id]: { rule: rule ? { ...rule, status: "locked" } : null, at: nowIso() },
    },
  };
}
