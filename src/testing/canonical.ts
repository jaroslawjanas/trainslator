import type { AnyNode, Element } from "domhandler";
import { decodeText, getAttr, isElement, localName, parseXml } from "../epub/xhtml.ts";

interface Token {
  kind: "open" | "close" | "text";
  value: string;
}

/**
 * Adjacent identical elements (same tag and attributes, nothing between them)
 * count as one, because the extractor may merge them. Merging repeats until
 * nothing changes: joining two parents can make their children neighbours,
 * and those must merge too, or the same structure would compare differently
 * depending on where the boundary was. Empty elements (images, breaks) never
 * merge.
 */
function mergeAdjacent(tokens: Token[]): Token[] {
  let list = tokens;
  for (;;) {
    const openOf = new Map<number, number>();
    const stack: number[] = [];
    list.forEach((t, i) => {
      if (t.kind === "open") stack.push(i);
      else if (t.kind === "close") openOf.set(i, stack.pop()!);
    });
    const closeOf = new Map([...openOf].map(([close, open]) => [open, close]));
    const at = list.findIndex((t, i) => {
      const next = list[i + 1];
      if (t.kind !== "close" || next?.kind !== "open") return false;
      const open = openOf.get(i)!;
      return list[open]!.value === next.value && open !== i - 1 && closeOf.get(i + 1) !== i + 2;
    });
    if (at < 0) return list;
    list = [...list.slice(0, at), ...list.slice(at + 2)];
  }
}

/**
 * A canonical form of an XHTML document for comparing a source with its
 * rebuilt output. It ignores what the extractor is allowed to change:
 * comments, soft hyphens, <wbr>, presentational spans/fonts (which may be
 * merged or unwrapped), whitespace runs, and language/direction attributes.
 */
export function canonical(src: string): string {
  const out: Token[] = [];
  const IGNORED_ATTRS = new Set(["lang", "xml:lang", "dir"]);

  function presentational(el: Element): boolean {
    const name = localName(el);
    if (name !== "span" && name !== "font") return false;
    for (const key of Object.keys(el.attribs)) {
      const k = key.toLowerCase();
      if (k === "id" || k === "xml:id" || k === "href" || k === "role" || k.endsWith(":type"))
        return false;
    }
    return true;
  }

  function openToken(node: Element): string {
    const attrs = Object.keys(node.attribs)
      .filter((k) => !IGNORED_ATTRS.has(k.toLowerCase()))
      .sort()
      .map((k) => `${k}="${decodeText(getAttr(node, k) ?? "")}"`)
      .join(" ");
    return `<${localName(node)}${attrs ? ` ${attrs}` : ""}>`;
  }

  function walk(node: AnyNode): void {
    if (node.type === "text") {
      out.push({ kind: "text", value: decodeText(node.data).replace(/­/g, "") });
      return;
    }
    if (node.type === "cdata") {
      for (const c of node.children)
        if (c.type === "text") out.push({ kind: "text", value: c.data });
      return;
    }
    if (!isElement(node)) {
      if ("children" in node) for (const c of node.children) walk(c);
      return;
    }
    const name = localName(node);
    if (name === "wbr") return;
    // Presentational spans are dissolved into their parent.
    if (presentational(node)) {
      for (const c of node.children) walk(c);
      return;
    }
    out.push({ kind: "open", value: openToken(node) });
    for (const c of node.children) walk(c);
    out.push({ kind: "close", value: `</${name}>` });
  }

  for (const c of parseXml(src).children) walk(c);
  return mergeAdjacent(out)
    .map((t) => t.value)
    .join("")
    .replace(/[ \t\r\n]+/g, " ")
    .replace(/> </g, "><")
    .trim();
}
