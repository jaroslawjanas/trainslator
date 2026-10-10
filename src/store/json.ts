import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { z } from "zod";

/** Thrown when a stored file doesn't match its schema. */
export class StoreError extends Error {
  readonly file: string;
  constructor(message: string, file: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreError";
    this.file = file;
  }
}

// ---------------------------------------------------------------------------
// Locks: one async mutex per file, so read-modify-write can't lose updates.
// ---------------------------------------------------------------------------

const lockTails = new Map<string, Promise<void>>();

function lockKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Runs `fn` while holding the lock for `file`. Calls for the same file run one at a time. */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(file);
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  lockTails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
const TEMP_SUFFIX = ".tmp-trainslator";

async function renameWithRetry(from: string, to: string): Promise<void> {
  const delays = [10, 25, 50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Antivirus scanners and indexers on Windows briefly hold files open.
      if (code && RETRYABLE_RENAME.has(code) && attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw error;
    }
  }
}

/** Writes a file by writing a temp file next to it and renaming it into place. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`;
  try {
    await fs.writeFile(temp, data);
    await renameWithRetry(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Removes temp files left behind by a crash. Call once at startup. */
export async function cleanupTempFiles(root: string): Promise<number> {
  let removed = 0;
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(TEMP_SUFFIX)) {
        await fs.rm(full, { force: true }).catch(() => {});
        removed++;
      }
    }
  }
  await walk(root);
  return removed;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reads and validates a JSON file. Returns undefined when the file doesn't exist. */
export async function readJson<S extends z.ZodType>(
  file: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  const text = await readText(file);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StoreError(`Corrupt JSON in ${file}`, file, { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new StoreError(
      `${path.basename(file)} doesn't match its schema: ${parsed.error.message}`,
      file,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export async function readJsonOr<S extends z.ZodType>(
  file: string,
  schema: S,
  fallback: () => z.output<S>,
): Promise<z.output<S>> {
  return (await readJson(file, schema)) ?? fallback();
}

/** Validates and writes a JSON file atomically. */
export async function writeJson<S extends z.ZodType>(
  file: string,
  schema: S,
  value: z.input<S>,
): Promise<z.output<S>> {
  const parsed = schema.parse(value);
  await writeJsonAtomic(file, parsed);
  return parsed;
}

/**
 * Read-modify-write under the file's lock. `fn` gets the current value (or the
 * fallback) and returns the new value.
 */
export async function updateJson<S extends z.ZodType>(
  file: string,
  schema: S,
  fallback: () => z.output<S>,
  fn: (current: z.output<S>) => z.input<S> | Promise<z.input<S>>,
): Promise<z.output<S>> {
  return withFileLock(file, async () => {
    const current = (await readJson(file, schema)) ?? fallback();
    const next = await fn(current);
    return writeJson(file, schema, next);
  });
}

/** Appends one JSON line under the file's lock. */
export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await withFileLock(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
  });
}

export async function readJsonLines<S extends z.ZodType>(
  file: string,
  schema: S,
): Promise<z.output<S>[]> {
  const text = await readText(file);
  if (!text) return [];
  const out: z.output<S>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A torn last line after a crash is skipped.
    }
  }
  return out;
}

export async function removePath(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
