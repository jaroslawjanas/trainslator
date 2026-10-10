import type { FakeReply } from "./fake-openai.ts";

/** Pulls the units JSON array out of a phase 3 / TOC request. */
export function requestedUnits(
  body: Record<string, unknown>,
): { id: string; text: string; keep?: string[] }[] {
  const messages = body.messages as { role: string; content: string | { text: string }[] }[];
  const user = messages.filter((m) => m.role === "user");
  const first = user[0];
  if (!first) return [];
  const content =
    typeof first.content === "string" ? first.content : first.content.map((p) => p.text).join("");
  const start = content.lastIndexOf("\n[\n");
  if (start < 0) return [];
  const end = content.lastIndexOf("\n]");
  return JSON.parse(content.slice(start + 1, end + 2));
}

/** Uppercases text outside placeholders, so output is easy to recognise. */
export function shout(text: string): string {
  return text.replace(
    /(<\/?g\d+>|<x\d+\/>)|([^<]+)/g,
    (_m, tag: string | undefined, txt: string | undefined) => tag ?? (txt ?? "").toUpperCase(),
  );
}

export function isTocRequest(body: Record<string, unknown>): boolean {
  return JSON.stringify(body.messages).includes("# Labels to translate");
}

/** A fake translator reply for any phase 3 or TOC request. */
export function translateReply(
  body: Record<string, unknown>,
  transform: (id: string, text: string) => string = (_i, t) => shout(t),
): FakeReply {
  const units = requestedUnits(body);
  const out = units.map((u) => ({ id: u.id, text: transform(u.id, u.text) }));
  if (isTocRequest(body)) return { content: JSON.stringify({ items: out }) };
  return { content: JSON.stringify({ units: out, coined: [] }) };
}
