import type { Edit } from "../prompts/phase2.ts";
import { nowIso } from "../shared/schemas/common.ts";
import type { Kb, KbEntry } from "../shared/schemas/kb.ts";
import { computeRefs, entryKeys, normalizeKey, slugId, uniqueId } from "./model.ts";

export interface EditOutcome {
  edit: Edit;
  result: "applied" | "rejected" | "suggestion";
  message: string;
  entryId: string | null;
}

export interface ApplyContext {
  /** Prompt id (p12) → entry id. */
  ids: Map<string, string>;
  /** Keys you deleted; they can't be added back. */
  deleted: Set<string>;
  /** Where these edits come from (a segment id), for refs. */
  refId: string | null;
  /** Text of the chapter, to compute refs of new or changed entries. */
  refText: string | null;
  /** The source language the names and terms are in. */
  lang: string;
}

/** Problems the model can fix in a repair turn (structural mistakes, duplicates, unknown ids). */
export function editProblems(kb: Kb, edits: Edit[], ctx: ApplyContext): string[] {
  return applyEdits(kb, edits, ctx)
    .outcomes.map((o, i) =>
      o.result === "rejected"
        ? `edit ${i + 1} (${o.edit.op} ${o.edit.id ?? o.edit.fields?.source ?? ""}): ${o.message}`
        : null,
    )
    .filter((p): p is string => p !== null);
}

/**
 * Applies the model's patch edits under the phase 2 rules:
 * - add can't re-add what you deleted; adding what already exists only fills
 *   the existing entry's gaps;
 * - update/resolve/remove need an existing id;
 * - edits to locked entries are kept as suggestions, not applied;
 * - open entries need a question; removals need a reason.
 * Null fields keep the current value; aliases are added; attributes merge by key.
 */
export function applyEdits(
  kb: Kb,
  edits: Edit[],
  ctx: ApplyContext,
): { kb: Kb; outcomes: EditOutcome[] } {
  const entries = kb.entries.map((e) => ({ ...e }));
  const outcomes: EditOutcome[] = [];
  const taken = new Set(entries.map((e) => e.id));
  const addedThisBatch = new Set<string>();
  const keyOwner = () => {
    const m = new Map<string, KbEntry>();
    for (const e of entries) for (const k of entryKeys(e, ctx.lang)) if (!m.has(k)) m.set(k, e);
    return m;
  };
  const refsFor = (e: Pick<KbEntry, "source" | "aliases">, old: string[]): string[] => {
    if (!ctx.refId || !ctx.refText) return old;
    const found = computeRefs(e, [{ id: ctx.refId, text: ctx.refText }], ctx.lang);
    return found.length > 0 && !old.includes(ctx.refId) ? [...old, ctx.refId] : old;
  };
  const promptIdOf = new Map([...ctx.ids].map(([p, id]) => [id, p]));

  for (const edit of edits) {
    const f = edit.fields;
    const reject = (message: string, entryId: string | null = null) =>
      outcomes.push({ edit, result: "rejected", message, entryId });

    if (edit.op === "add") {
      if (!f?.source?.trim() || !f.kind) {
        reject("an added entry needs at least kind and source");
        continue;
      }
      const key = normalizeKey(f.source, ctx.lang);
      if (ctx.deleted.has(key)) {
        reject("the editor deleted this entry; don't add it again");
        continue;
      }
      const owner = keyOwner().get(key);
      if (owner) {
        // Models often re-add what is already listed. The existing entry's
        // decisions stand; the new edit only fills gaps.
        const label = promptIdOf.get(owner.id) ?? `"${owner.source}"`;
        if (owner.status === "locked") {
          outcomes.push({
            edit,
            result: "suggestion",
            message: `already listed as ${label}, which is locked; kept as a suggestion`,
            entryId: owner.id,
          });
          continue;
        }
        const j = entries.findIndex((e) => e.id === owner.id);
        const aliases = [...owner.aliases];
        for (const a of f.aliases ?? []) {
          const t = a.trim();
          if (
            t &&
            !entryKeys({ source: owner.source, aliases }, ctx.lang).includes(
              normalizeKey(t, ctx.lang),
            )
          )
            aliases.push(t);
        }
        const attributes = [...owner.attributes];
        for (const a of f.attributes ?? []) {
          const k = a.key.trim();
          if (
            k &&
            a.value.trim() &&
            !attributes.some((x) => x.key.toLowerCase() === k.toLowerCase())
          )
            attributes.push({ key: k, value: a.value.trim() });
        }
        const merged: KbEntry = {
          ...owner,
          aliases,
          attributes,
          target: owner.target ?? (f.target?.trim() || null),
          treatment: owner.treatment ?? f.treatment ?? null,
          note: owner.note || f.note?.trim() || "",
          updatedAt: nowIso(),
        };
        merged.refs = refsFor(merged, owner.refs);
        entries[j] = merged;
        outcomes.push({
          edit,
          result: "applied",
          message: `already listed as ${label}; filled in what was missing`,
          entryId: owner.id,
        });
        continue;
      }
      const status = f.status === "open" ? "open" : "auto";
      if (status === "open" && !f.question?.trim()) {
        reject("an open entry needs a question");
        continue;
      }
      const base = {
        source: f.source.trim(),
        aliases: (f.aliases ?? [])
          .map((a) => a.trim())
          .filter((a) => a && normalizeKey(a, ctx.lang) !== key),
      };
      const entry: KbEntry = {
        id: uniqueId(slugId("b", base.source), taken),
        kind: f.kind,
        ...base,
        target: f.target?.trim() || null,
        targetSeen: [],
        treatment: f.treatment ?? null,
        attributes: (f.attributes ?? []).filter((a) => a.key.trim() && a.value.trim()),
        note: f.note?.trim() ?? "",
        examples: [],
        refs: refsFor(base, ctx.refId ? [ctx.refId] : []),
        status,
        question: status === "open" ? (f.question?.trim() ?? null) : null,
        origin: "phase2",
        updatedAt: nowIso(),
      };
      entries.push(entry);
      addedThisBatch.add(entry.id);
      outcomes.push({ edit, result: "applied", message: "added", entryId: entry.id });
      continue;
    }

    const entryId = edit.id ? ctx.ids.get(edit.id) : undefined;
    const i = entryId ? entries.findIndex((e) => e.id === entryId) : -1;
    if (i < 0) {
      reject(`unknown id ${edit.id ?? "(none)"}; use an id from the knowledge base`);
      continue;
    }
    const current = entries[i]!;
    if (addedThisBatch.has(current.id)) {
      reject("can't change an entry added in the same answer");
      continue;
    }
    if (current.status === "locked") {
      outcomes.push({
        edit,
        result: "suggestion",
        message: "the entry is locked by the editor; kept as a suggestion",
        entryId: current.id,
      });
      continue;
    }
    if (edit.op === "remove") {
      if (!edit.reason.trim()) {
        reject("a removal needs a reason");
        continue;
      }
      entries.splice(i, 1);
      outcomes.push({ edit, result: "applied", message: "removed", entryId: current.id });
      continue;
    }
    if (!f) {
      reject(`"${edit.op}" needs fields`);
      continue;
    }
    if (edit.op === "resolve" && f.target === null && f.attributes === null && f.note === null) {
      reject("resolving needs the decided translation or facts");
      continue;
    }
    const attributes = [...current.attributes];
    for (const a of f.attributes ?? []) {
      const k = a.key.trim();
      if (!k || !a.value.trim()) continue;
      const j = attributes.findIndex((x) => x.key.toLowerCase() === k.toLowerCase());
      if (j >= 0) attributes[j] = { key: attributes[j]!.key, value: a.value.trim() };
      else attributes.push({ key: k, value: a.value.trim() });
    }
    const aliases = [...current.aliases];
    for (const a of f.aliases ?? []) {
      const t = a.trim();
      if (
        t &&
        !entryKeys({ source: current.source, aliases }, ctx.lang).includes(
          normalizeKey(t, ctx.lang),
        )
      )
        aliases.push(t);
    }
    let status = current.status;
    let question = current.question;
    if (edit.op === "resolve" || f.status === "auto") {
      status = "auto";
      question = null;
    } else if (f.status === "open") {
      status = "open";
      question = f.question?.trim() || current.question;
      if (!question) {
        reject("an open entry needs a question");
        continue;
      }
    } else if (f.question !== null && status === "open") {
      question = f.question.trim() || question;
    }
    const updated: KbEntry = {
      ...current,
      kind: f.kind ?? current.kind,
      source: f.source?.trim() || current.source,
      aliases,
      target: f.target !== null ? f.target.trim() || null : current.target,
      treatment: f.treatment ?? current.treatment,
      attributes,
      note: f.note !== null ? f.note.trim() : current.note,
      status,
      question,
      updatedAt: nowIso(),
    };
    updated.refs = refsFor(updated, current.refs);
    entries[i] = updated;
    outcomes.push({
      edit,
      result: "applied",
      message: edit.op === "resolve" ? "resolved" : "updated",
      entryId: current.id,
    });
  }
  return { kb: { ...kb, entries }, outcomes };
}
