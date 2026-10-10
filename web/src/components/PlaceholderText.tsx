import { createElement, type ReactNode } from "react";

export interface PlaceholderInfo {
  n: number;
  kind: "g" | "x";
  label: string;
  required: boolean;
}

const TOKEN = /<(\/?)g(\d+)>|<x(\d+)\/>/g;

/** Inline elements that are shown as the formatting they stand for. */
const FORMAT: Record<string, string> = {
  i: "em",
  em: "em",
  cite: "em",
  dfn: "em",
  var: "em",
  b: "strong",
  strong: "strong",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  sup: "sup",
  sub: "sub",
  small: "small",
};

/** Human names for the self-contained placeholders shown as small tokens. */
const TOKEN_LABEL: Record<string, string> = {
  img: "image",
  svg: "drawing",
  math: "formula",
  video: "video",
  audio: "audio",
  object: "object",
  ruby: "ruby",
};

interface Node {
  n: number | null;
  label: string;
  children: (Node | string)[];
}

/** Builds a tree from the placeholder text; null when the tags don't nest. */
function parseTree(text: string, labels: Map<number, string>): Node | null {
  const root: Node = { n: null, label: "", children: [] };
  const stack: Node[] = [root];
  let pos = 0;
  for (const m of text.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (m.index > pos) top.children.push(text.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[3] !== undefined) {
      const n = Number(m[3]);
      top.children.push({ n, label: `x:${labels.get(n) ?? "?"}`, children: [] });
    } else if (m[1]) {
      if (top.n !== Number(m[2])) return null;
      stack.pop();
    } else {
      const n = Number(m[2]);
      const node: Node = { n, label: labels.get(n) ?? "?", children: [] };
      top.children.push(node);
      stack.push(node);
    }
  }
  if (stack.length !== 1) return null;
  if (pos < text.length) root.children.push(text.slice(pos));
  return root;
}

function render(node: Node | string, key: string, showTags: boolean): ReactNode {
  if (typeof node === "string") return node;
  if (node.label.startsWith("x:")) {
    const label = node.label.slice(2);
    const tag = showTags ? (
      <span key={`${key}t`} className="tr-tag">
        {label}
      </span>
    ) : null;
    if (label === "br" || label === "newline") return showTags ? [tag, "\n"] : "\n";
    if (label === "note reference")
      return (
        <sup key={key} className="tr-fmt-noteref" title="Note reference">
          †
        </sup>
      );
    if (label === "page break") return tag;
    return (
      <span key={key} className="tr-fmt-token" title={`<x${node.n}/>`}>
        {TOKEN_LABEL[label] ?? label}
      </span>
    );
  }
  const children = node.children.map((c, i) => render(c, `${key}.${i}`, showTags));
  const element = FORMAT[node.label];
  const inner = element
    ? createElement(element, { key: `${key}e` }, children)
    : node.label === "a"
      ? createElement("span", { key: `${key}e`, className: "tr-fmt-link" }, children)
      : createElement("span", { key: `${key}e`, title: node.label }, children);
  if (!showTags) return inner;
  return [
    <span key={`${key}o`} className="tr-tag">
      {node.label}
    </span>,
    inner,
    <span key={`${key}c`} className="tr-tag">
      /{node.label}
    </span>,
  ];
}

/** Flat fallback when the tags don't nest: text with every tag visible. */
function renderFlat(text: string, labels: Map<number, string>): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > pos) out.push(text.slice(pos, m.index));
    const n = Number(m[2] ?? m[3]);
    const label = labels.get(n) ?? "?";
    out.push(
      <span key={`f${i++}`} className="tr-tag" title={m[0]}>
        {m[1] ? "/" : ""}
        {label}
      </span>,
    );
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/**
 * A unit of book text with its formatting rebuilt from the placeholders:
 * italics as italics, line breaks as breaks, note references as small marks.
 * Built as React elements, never as HTML. With `showTags`, the tags
 * themselves are shown too, for checking that formatting survived.
 */
export function UnitText({
  text,
  placeholders,
  showTags = false,
}: {
  text: string;
  placeholders: PlaceholderInfo[];
  showTags?: boolean;
}) {
  const labels = new Map(placeholders.map((p) => [p.n, p.label]));
  const tree = parseTree(text, labels);
  return (
    <div className="tr-page-text">
      {tree
        ? tree.children.map((c, i) => render(c, String(i), showTags))
        : renderFlat(text, labels)}
    </div>
  );
}
