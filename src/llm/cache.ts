import { z } from "zod";
import { listDir, readJson, removePath, writeJson } from "../store/json.ts";
import type { DataPaths } from "../store/paths.ts";

const CacheEntry = z.object({
  raw: z.string(),
  model: z.string(),
  at: z.string(),
});
type CacheEntry = z.infer<typeof CacheEntry>;

/**
 * Validated responses keyed by a hash of the request. Resuming or re-running a
 * step reuses identical answers for free. Only answers that passed validation
 * are stored; they are validated again when read.
 */
export class ResponseCache {
  private readonly paths: DataPaths;

  constructor(paths: DataPaths) {
    this.paths = paths;
  }

  async get(projectId: string, hash: string): Promise<CacheEntry | undefined> {
    try {
      return await readJson(this.paths.llmCache(projectId, hash), CacheEntry);
    } catch {
      return undefined;
    }
  }

  async put(projectId: string, hash: string, entry: CacheEntry): Promise<void> {
    await writeJson(this.paths.llmCache(projectId, hash), CacheEntry, entry);
  }

  async clear(projectId: string): Promise<number> {
    const dir = this.paths.llmCacheDir(projectId);
    const files = await listDir(dir);
    await removePath(dir);
    return files.length;
  }
}
