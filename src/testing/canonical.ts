import type { AnyNode, Element } from "domhandler";
import { decodeText, getAttr, isElement, localName, parseXml } from "../epub/xhtml.ts";

/**
 * A canonical form of an XHTML document for comparing a source with its
 * rebuilt output. It ignores what the extractor is allowed to change:
 * comments, soft hyphens, <wbr>, presentational spans/fonts (which may be
 * merged or unwrapped), whitespace runs, and language/direction attributes.
 */
export function canonical(src: string): string {
  const out: string[] = [];
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

  function walk(node: AnyNode): void {
    if (node.type === "text") {
      out.push(decodeText(node.data).replace(/\u00ad/g, ""));
      return;
    }
    if (node.type === "cdata") {
      for (const c of node.children) if (c.type === "text") out.push(c.data);
      return;
    }
    if (!isElement(node)) {
      if ("children" in node) for (const c of node.children) walk(c);
      return;
    }
    const name = localName(node);
    if (name === "wbr") return;
    if (presentational(node)) {
      for (const c of node.children) walk(c);
      return;
    }
    out.push(openToken(node));
    walkChildren(node.children);
    out.push(`</${name}>`);
  }

  function openToken(node: Element): string {
    const attrs = Object.keys(node.attribs)
      .filter((k) => !IGNORED_ATTRS.has(k.toLowerCase()))
      .sort()
      .map((k) => `${k}="${decodeText(getAttr(node, k) ?? "")}"`)
      .join(" ");
    return `<${localName(node)}${attrs ? ` ${attrs}` : ""}>`;
  }

  /** Presentational spans are dissolved into their parent's child list. */
  function flatten(children: AnyNode[]): AnyNode[] {
    const out: AnyNode[] = [];
    for (const c of children) {
      if (isElement(c) && (presentational(c) || localName(c) === "wbr")) {
        if (localName(c) !== "wbr") out.push(...flatten(c.children));
      } else {
        out.push(c);
      }
    }
    return out;
  }

  /** Adjacent identical elements (same tag and attributes) count as one, as the extractor may merge them. */
  function walkChildren(raw: AnyNode[]): void {
    const children = flatten(raw);
    let prevOpen: string | null = null;
    for (const c of children) {
      if (isElement(c) && !presentational(c) && localName(c) !== "wbr") {
        const open = openToken(c);
        const voidish = c.children.length === 0;
        if (prevOpen === open && !voidish && out[out.length - 1] === `</${localName(c)}>`) {
          out.pop();
          walkChildren(c.children);
          out.push(`</${localName(c)}>`);
          continue;
        }
        walk(c);
        prevOpen = voidish ? null : open;
        continue;
      }
      walk(c);
      if (c.type !== "comment") prevOpen = null;
    }
  }

  walkChildren(parseXml(src).children);
  return out
    .join("")
    .replace(/[ \t\r\n]+/g, " ")
    .replace(/> </g, "><")
    .trim();
}
