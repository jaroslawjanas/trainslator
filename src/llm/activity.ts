import { AsyncLocalStorage } from "node:async_hooks";
import type { CallLogEntry } from "./log.ts";

/**
 * What the AI layer is doing right now, per job: requests waiting for a
 * free slot, requests running (with how much of the answer has arrived),
 * and the requests that finished recently. Jobs run their handler inside
 * `jobScope`, so every request knows which job it belongs to.
 */

export const jobScope = new AsyncLocalStorage<{ jobId: string }>();

export function currentJobId(): string | null {
  return jobScope.getStore()?.jobId ?? null;
}

export interface ActiveCall {
  id: string;
  jobId: string | null;
  projectId: string | null;
  step: string;
  label: string;
  modelName: string;
  reasoning: { enabled: boolean; effort: string | null };
  attempt: number;
  /** When the request started waiting for a slot. */
  queuedAt: string;
  /** When it was sent; null while it waits for a free slot. */
  sentAt: string | null;
  /** Characters of answer (and visible reasoning) received so far, when streaming. */
  receivedChars: number;
}

export interface ActiveCallView extends ActiveCall {
  receivedTokens: number;
}

export interface CallHandle {
  sent(): void;
  received(chars: number): void;
  end(): void;
}

const MAX_FINISHED_PER_JOB = 3000;

export class ActivityRegistry {
  private readonly active = new Map<string, ActiveCall>();
  private readonly finished = new Map<string, CallLogEntry[]>();

  begin(call: Omit<ActiveCall, "sentAt" | "receivedChars">): CallHandle {
    const entry: ActiveCall = { ...call, sentAt: null, receivedChars: 0 };
    this.active.set(call.id, entry);
    return {
      sent: () => {
        entry.sentAt = new Date().toISOString();
      },
      received: (chars) => {
        entry.receivedChars += chars;
      },
      end: () => {
        this.active.delete(call.id);
      },
    };
  }

  /** Requests of a job that are waiting or running, oldest first. */
  activeFor(jobId: string): ActiveCallView[] {
    return [...this.active.values()]
      .filter((c) => c.jobId === jobId)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
      .map((c) => ({ ...c, receivedTokens: Math.round(c.receivedChars / 3.8) }));
  }

  recordFinished(entry: CallLogEntry): void {
    if (!entry.jobId) return;
    const list = this.finished.get(entry.jobId) ?? [];
    list.push(entry);
    if (list.length > MAX_FINISHED_PER_JOB) list.splice(0, list.length - MAX_FINISHED_PER_JOB);
    this.finished.set(entry.jobId, list);
  }

  /** Finished requests of a job seen since the server started; undefined when none. */
  finishedFor(jobId: string): CallLogEntry[] | undefined {
    return this.finished.get(jobId);
  }
}
