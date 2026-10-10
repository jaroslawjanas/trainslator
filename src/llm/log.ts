import { z } from "zod";
import { Usage } from "../shared/schemas/common.ts";
import type { Pricing } from "../shared/schemas/settings.ts";
import { appendJsonLine, readJsonLines, writeFileAtomic } from "../store/json.ts";
import type { DataPaths } from "../store/paths.ts";
import type { NormalizedUsage } from "./response.ts";

export const CallLogEntry = z.object({
  id: z.string(),
  /** When the request was sent (after waiting for a free slot). */
  at: z.string(),
  projectId: z.string().nullable(),
  /** The job that made the request, if any. */
  jobId: z.string().nullable().default(null),
  step: z.string(),
  label: z.string(),
  modelId: z.string(),
  modelName: z.string(),
  attempt: z.number().int(),
  /** request = sent to the provider; cache_hit = answered from the response cache. */
  kind: z.enum(["request", "cache_hit"]),
  requestHash: z.string(),
  blockTokens: z.array(z.object({ label: z.string(), tokens: z.number() })),
  params: z.record(z.string(), z.unknown()),
  finishReason: z.string().nullable(),
  /** Time from sending to the complete answer. */
  latencyMs: z.number(),
  /** Time spent waiting for a free slot before sending. */
  waitMs: z.number().default(0),
  usage: Usage,
  error: z.string().nullable(),
});
export type CallLogEntry = z.infer<typeof CallLogEntry>;

export function costOf(usage: NormalizedUsage | null, pricing: Pricing | null): number | null {
  if (!usage) return null;
  if (usage.cost !== null) return usage.cost;
  if (!pricing) return null;
  const uncached = Math.max(0, usage.promptTokens - usage.cachedTokens - usage.cacheWriteTokens);
  return (
    (uncached * pricing.inputPerM +
      usage.cachedTokens * pricing.cachedInputPerM +
      usage.cacheWriteTokens * pricing.cacheWritePerM +
      usage.completionTokens * pricing.outputPerM) /
    1_000_000
  );
}

export class CallLog {
  private readonly paths: DataPaths;
  private readonly options: { logBodies: () => boolean; onEntry?: (entry: CallLogEntry) => void };

  constructor(
    paths: DataPaths,
    options: { logBodies: () => boolean; onEntry?: (entry: CallLogEntry) => void },
  ) {
    this.paths = paths;
    this.options = options;
  }

  async append(
    entry: CallLogEntry,
    bodies?: { request: unknown; response: unknown },
  ): Promise<void> {
    this.options.onEntry?.(entry);
    if (!entry.projectId) return;
    await appendJsonLine(this.paths.callsLog(entry.projectId), entry);
    if (bodies && this.options.logBodies()) {
      await writeFileAtomic(
        this.paths.callDetail(entry.projectId, entry.id),
        JSON.stringify(bodies, null, 2),
      );
    }
  }

  async read(projectId: string): Promise<CallLogEntry[]> {
    return readJsonLines(this.paths.callsLog(projectId), CallLogEntry);
  }
}
