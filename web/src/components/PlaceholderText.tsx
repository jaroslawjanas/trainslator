import { Text } from "@mantine/core";
import { Fragment } from "react";

export interface PlaceholderInfo {
  n: number;
  kind: "g" | "x";
  label: string;
  required: boolean;
}

const TOKEN = /<(\/?)g(\d+)>|<x(\d+)\/>/g;

/**
 * Shows unit text with placeholders as small chips (never as HTML), e.g.
 * "She kept a ⟨i⟩small⟨/i⟩ notebook.⟨note reference⟩".
 */
export function PlaceholderText({
  text,
  placeholders,
  size = "sm",
}: {
  text: string;
  placeholders: PlaceholderInfo[];
  size?: string;
}) {
  const byN = new Map(placeholders.map((p) => [p.n, p]));
  const parts: { key: string; text?: string; chip?: string; title?: string }[] = [];
  let pos = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > pos) parts.push({ key: `t${i++}`, text: text.slice(pos, m.index) });
    const n = Number(m[2] ?? m[3]);
    const p = byN.get(n);
    const label = p?.label ?? "?";
    if (m[3] !== undefined)
      parts.push({ key: `x${i++}`, chip: label === "newline" ? "↵" : label, title: `<x${n}/>` });
    else parts.push({ key: `g${i++}`, chip: m[1] ? `/${label}` : label, title: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) parts.push({ key: `t${i++}`, text: text.slice(pos) });
  return (
    <Text size={size} className="unit-text">
      {parts.map((p) =>
        p.chip !== undefined ? (
          <span key={p.key} className="placeholder-chip" title={p.title}>
            {p.chip}
          </span>
        ) : (
          <Fragment key={p.key}>{p.text}</Fragment>
        ),
      )}
    </Text>
  );
}
