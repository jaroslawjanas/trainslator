import { EventEmitter } from "node:events";
import type { Job, JobEvent } from "../shared/schemas/jobs.ts";

/** In-process event bus; the SSE route forwards these to the browser. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: JobEvent): void {
    this.emitter.emit("event", event);
  }

  job(job: Job): void {
    this.emit({ type: "job", job });
  }

  changed(projectId: string, topic: string, targetId: string | null = null): void {
    this.emit({ type: "changed", projectId, topic, targetId });
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
