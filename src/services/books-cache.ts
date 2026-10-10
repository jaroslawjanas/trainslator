import { promises as fs } from "node:fs";
import { EpubBook } from "../epub/book.ts";

/** Keeps a few parsed EPUBs in memory; parsing a large book takes a second or two. */
export class BookCache {
  private readonly entries = new Map<string, { mtimeMs: number; book: EpubBook; used: number }>();
  private readonly max: number;

  constructor(max = 6) {
    this.max = max;
  }

  async open(file: string): Promise<EpubBook> {
    const stat = await fs.stat(file);
    const cached = this.entries.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      cached.used = Date.now();
      return cached.book;
    }
    const bytes = new Uint8Array(await fs.readFile(file));
    const book = EpubBook.open(bytes, { rejectFixedLayout: false });
    this.entries.set(file, { mtimeMs: stat.mtimeMs, book, used: Date.now() });
    if (this.entries.size > this.max) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    return book;
  }

  forget(file: string): void {
    this.entries.delete(file);
  }
}
