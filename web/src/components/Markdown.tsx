import type { ReactNode } from "react";

/**
 * A small Markdown renderer for notes the AI writes: headings, lists,
 * paragraphs, **bold**, *italic* and `code`. It builds React elements and
 * never inserts HTML, so model output can't inject markup.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/g;
  let pos = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > pos) out.push(text.slice(pos, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[2] !== undefined) out.push(<strong key={key}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<code key={key}>{m[3]}</code>);
    else out.push(<em key={key}>{m[4] ?? m[5]}</em>);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "ul" | "ol"; items: string[] };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", text: para.join(" ") });
    para = [];
  };
  for (const raw of src.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ t: "h", level: heading[1]!.length, text: heading[2]! });
    } else if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const text = (bullet ?? numbered)![1]!;
      const last = blocks[blocks.length - 1];
      if (last && last.t === kind) last.items.push(text);
      else blocks.push({ t: kind, items: [text] });
    } else {
      const last = blocks[blocks.length - 1];
      // A wrapped continuation line of a list item.
      if (!para.length && last && (last.t === "ul" || last.t === "ol") && /^\s+/.test(raw))
        last.items[last.items.length - 1] += ` ${line.trim()}`;
      else para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export function Markdown({ source }: { source: string }) {
  const blocks = parse(source);
  return (
    <div className="tr-prose">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        if (b.t === "h") {
          const level = Math.min(4, Math.max(2, b.level + 1));
          const Tag = `h${level}` as "h2" | "h3" | "h4";
          return <Tag key={key}>{inline(b.text, key)}</Tag>;
        }
        if (b.t === "p") return <p key={key}>{inline(b.text, key)}</p>;
        const List = b.t;
        return (
          <List key={key}>
            {b.items.map((item, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static rendering of parsed text
              <li key={j}>{inline(item, `${key}-${j}`)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
