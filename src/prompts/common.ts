/** Shared prompt pieces. Everything static must render identically on every call. */

export function languageNotesBlock(targetName: string, notes: string): string {
  const trimmed = notes.trim();
  if (!trimmed) return "";
  return `\n\n## Notes about ${targetName}\n${trimmed}`;
}

export function referenceKbBlock(text: string): string {
  return `# Knowledge from earlier human translations\nThese entries record how professional translators handled names, terms, wordplay and style in related books. Follow them unless this book clearly calls for something else.\n\n${text}`;
}

export function bookKbBlock(text: string): string {
  return `# Knowledge base for this book\nDecided translations and facts for this book. Use them consistently. Entries marked [locked] were set by the editor and must be followed exactly.\n\n${text}`;
}

/** JSON array with one item per line, so long inputs stay readable for the model. */
export function jsonLines(items: unknown[]): string {
  return `[\n${items.map((i) => JSON.stringify(i)).join(",\n")}\n]`;
}
