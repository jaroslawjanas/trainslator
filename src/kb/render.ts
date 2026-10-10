import type { Kb, KbEntry, KbKind } from "../shared/schemas/kb.ts";

/**
 * Deterministic KB → prompt text. The same KB always renders to the same
 * bytes (no timestamps, stable order), so it can sit in a cached prefix.
 */

const SECTIONS: { title: string; kinds: KbKind[] }[] = [
  { title: "Characters", kinds: ["person"] },
  { title: "Places", kinds: ["place"] },
  { title: "Organizations, titles and named things", kinds: ["organization", "named_thing"] },
  { title: "Terms and recurring phrases", kinds: ["term", "phrase", "other"] },
  { title: "Wordplay and jokes", kinds: ["wordplay"] },
];

export interface RenderOptions {
  /** Short prompt ids per entry id (e.g. p12), so the model can refer to entries. */
  ids?: Map<string, string>;
  /** Show the [locked] marker (book KBs). */
  markLocked?: boolean;
}

function firstRef(e: KbEntry): string {
  return e.refs[0] ?? "~";
}

function refOrder(a: KbEntry, b: KbEntry): number {
  const ra = firstRef(a);
  const rb = firstRef(b);
  const na = Number(/\d+/.exec(ra)?.[0] ?? Number.MAX_SAFE_INTEGER);
  const nb = Number(/\d+/.exec(rb)?.[0] ?? Number.MAX_SAFE_INTEGER);
  return na - nb || ra.localeCompare(rb) || a.id.localeCompare(b.id);
}

export function renderEntry(e: KbEntry, options: RenderOptions = {}): string {
  const id = options.ids?.get(e.id);
  const parts: string[] = [];
  if (id) parts.push(`[${id}]`);
  if (options.markLocked && e.status === "locked") parts.push("[locked]");
  parts.push(e.source);
  parts.push("→");
  parts.push(e.target ?? "(undecided)");
  if (e.treatment && e.treatment !== "translated") parts.push(`(${e.treatment})`);
  if (e.attributes.length > 0)
    parts.push(`[${e.attributes.map((a) => `${a.key}: ${a.value}`).join("; ")}]`);
  let line = parts.join(" ");
  if (e.targetSeen.length > 0) line += ` — forms: ${e.targetSeen.slice(0, 6).join(", ")}`;
  if (e.note) line += ` — ${e.note}`;
  if (e.aliases.length > 0) line += ` (also: ${e.aliases.join(", ")})`;
  if (e.examples.length > 0 && (e.kind === "wordplay" || e.kind === "phrase")) {
    line += e.examples
      .slice(0, 2)
      .map((x) => `\n    e.g. "${x.source}"${x.target ? ` → "${x.target}"` : ""}`)
      .join("");
  }
  return `- ${line}`;
}

export function renderKb(kb: Kb, options: RenderOptions = {}): string {
  const out: string[] = [];
  const decided = kb.entries.filter((e) => e.status !== "open");
  for (const section of SECTIONS) {
    const list = decided.filter((e) => section.kinds.includes(e.kind)).sort(refOrder);
    if (list.length === 0) continue;
    out.push(`## ${section.title}`);
    for (const e of list) out.push(renderEntry(e, options));
    out.push("");
  }
  if (kb.styleRules.length > 0) {
    out.push("## Style rules");
    kb.styleRules.forEach((r, i) => {
      out.push(`${i + 1}. ${r.rule}`);
      for (const x of r.examples.slice(0, 1))
        out.push(`   e.g. "${x.source}"${x.target ? ` → "${x.target}"` : ""}`);
    });
    out.push("");
  }
  const open = kb.entries.filter((e) => e.status === "open").sort(refOrder);
  if (open.length > 0) {
    out.push("## Open questions");
    for (const e of open)
      out.push(`${renderEntry(e, options)}${e.question ? `\n    question: ${e.question}` : ""}`);
    out.push("");
  }
  return out.join("\n").trim();
}

/** Several reference KBs, in the book's chosen order. */
export function renderReferenceKbs(kbs: { title: string; kb: Kb }[]): string {
  return kbs
    .filter((k) => k.kb.entries.length > 0 || k.kb.styleRules.length > 0)
    .map((k) => `### From "${k.title}"\n${renderKb(k.kb)}`)
    .join("\n\n");
}

/** Short prompt ids (p1, p2 …) in render order. */
export function promptIds(kb: Kb, prefix = "p"): Map<string, string> {
  const order = [...kb.entries].sort((a, b) => a.kind.localeCompare(b.kind) || refOrder(a, b));
  return new Map(order.map((e, i) => [e.id, `${prefix}${i + 1}`]));
}
