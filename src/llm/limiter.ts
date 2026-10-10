/**
 * How many requests run at once per connection (provider), across all its
 * models and all jobs. Two lanes: interactive calls (Test, re-translating
 * one unit) go first. After a rate-limit error the connection's parallelism
 * is halved and recovers gradually with successful calls.
 */

export type Lane = "normal" | "interactive";

interface Waiter {
  lane: Lane;
  resolve: () => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

class Semaphore {
  active = 0;
  private readonly queue: Waiter[] = [];
  private readonly limit: () => number;

  constructor(limit: () => number) {
    this.limit = limit;
  }

  acquire(lane: Lane, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit() && this.queue.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { lane, resolve, reject, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      if (lane === "interactive") {
        const firstNormal = this.queue.findIndex((w) => w.lane === "normal");
        if (firstNormal >= 0) this.queue.splice(firstNormal, 0, waiter);
        else this.queue.push(waiter);
      } else {
        this.queue.push(waiter);
      }
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  drain(): void {
    while (this.queue.length > 0 && this.active < this.limit()) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      this.active++;
      next.resolve();
    }
  }

  get waiting(): number {
    return this.queue.length;
  }
}

function abortError(): Error {
  const e = new Error("Cancelled");
  e.name = "AbortError";
  return e;
}

export class Limiter {
  private readonly connections = new Map<string, Semaphore>();
  private readonly factors = new Map<string, number>();
  private readonly limit: (connectionId: string) => number;

  constructor(limit: (connectionId: string) => number) {
    this.limit = limit;
  }

  private sem(connectionId: string): Semaphore {
    let sem = this.connections.get(connectionId);
    if (!sem) {
      sem = new Semaphore(() => {
        const base = this.limit(connectionId);
        return Math.max(1, Math.floor(base * (this.factors.get(connectionId) ?? 1)));
      });
      this.connections.set(connectionId, sem);
    }
    return sem;
  }

  /** Waits for a slot on the connection. Returns the release function. */
  async acquire(
    connectionId: string,
    lane: Lane = "normal",
    signal?: AbortSignal,
  ): Promise<() => void> {
    const sem = this.sem(connectionId);
    await sem.acquire(lane, signal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      sem.release();
    };
  }

  /** Halves the connection's effective parallelism after a rate-limit error. */
  backoff(connectionId: string): void {
    const current = this.factors.get(connectionId) ?? 1;
    this.factors.set(connectionId, Math.max(0.05, current / 2));
  }

  /** Recovers parallelism gradually after successful calls. */
  recover(connectionId: string): void {
    const current = this.factors.get(connectionId) ?? 1;
    if (current >= 1) return;
    this.factors.set(connectionId, Math.min(1, current * 1.25));
    this.connections.get(connectionId)?.drain();
  }

  stats(connectionId: string): { active: number; waiting: number } {
    const sem = this.connections.get(connectionId);
    return { active: sem?.active ?? 0, waiting: sem?.waiting ?? 0 };
  }
}
