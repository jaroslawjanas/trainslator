import type { Connection } from "../shared/schemas/settings.ts";

/**
 * One request's timers: a total deadline, an idle watchdog that fires when a
 * stream goes quiet, and the caller's cancel signal. Transports pass
 * `signal` to their HTTP call and report every chunk with `activity()`.
 */
export class Watch {
  private readonly controller = new AbortController();
  private readonly deadline: NodeJS.Timeout;
  private idle: NodeJS.Timeout | null = null;
  private readonly connection: Connection;
  private readonly external: AbortSignal | undefined;
  private readonly onExternalAbort = () => this.controller.abort();
  /** Why the request was stopped by a timer, if it was. */
  timedOut: string | null = null;

  constructor(connection: Connection, external?: AbortSignal) {
    this.connection = connection;
    this.external = external;
    external?.addEventListener("abort", this.onExternalAbort, { once: true });
    this.deadline = setTimeout(() => {
      this.timedOut = `No complete answer after ${connection.timeoutSec} s (the connection's time limit).`;
      this.controller.abort();
    }, connection.timeoutSec * 1000);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Data arrived: restart the idle watchdog. */
  activity(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.timedOut = `No data from the provider for ${this.connection.idleTimeoutSec} s.`;
      this.controller.abort();
    }, this.connection.idleTimeoutSec * 1000);
  }

  dispose(): void {
    clearTimeout(this.deadline);
    if (this.idle) clearTimeout(this.idle);
    this.external?.removeEventListener("abort", this.onExternalAbort);
  }
}
