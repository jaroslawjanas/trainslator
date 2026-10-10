import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  appendJsonLine,
  cleanupTempFiles,
  readJson,
  readJsonLines,
  StoreError,
  updateJson,
  writeJson,
} from "./json.ts";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "trainslator-store-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const Counter = z.object({ n: z.number() });

describe("json store", () => {
  it("returns undefined for a missing file", async () => {
    expect(await readJson(path.join(dir, "missing.json"), Counter)).toBeUndefined();
  });

  it("writes atomically and reads back", async () => {
    const file = path.join(dir, "a", "b", "c.json");
    await writeJson(file, Counter, { n: 3 });
    expect(await readJson(file, Counter)).toEqual({ n: 3 });
    const files = await fs.readdir(path.dirname(file));
    expect(files).toEqual(["c.json"]);
  });

  it("rejects files that don't match the schema", async () => {
    const file = path.join(dir, "bad.json");
    await fs.writeFile(file, JSON.stringify({ n: "x" }));
    await expect(readJson(file, Counter)).rejects.toBeInstanceOf(StoreError);
  });

  it("doesn't lose concurrent updates", async () => {
    const file = path.join(dir, "counter.json");
    await Promise.all(
      Array.from({ length: 50 }, () =>
        updateJson(
          file,
          Counter,
          () => ({ n: 0 }),
          async (cur) => {
            await new Promise((r) => setTimeout(r, Math.random() * 3));
            return { n: cur.n + 1 };
          },
        ),
      ),
    );
    expect(await readJson(file, Counter)).toEqual({ n: 50 });
  });

  it("appends and reads JSON lines, skipping a torn last line", async () => {
    const file = path.join(dir, "log.jsonl");
    await appendJsonLine(file, { n: 1 });
    await appendJsonLine(file, { n: 2 });
    await fs.appendFile(file, '{"n": 3');
    expect(await readJsonLines(file, Counter)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("cleans up leftover temp files", async () => {
    await fs.writeFile(path.join(dir, "x.json.123.abc.tmp-trainslator"), "{}");
    expect(await cleanupTempFiles(dir)).toBe(1);
  });
});
