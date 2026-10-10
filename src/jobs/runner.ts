import { jobScope } from "../llm/activity.ts";
import { isLlmError } from "../llm/errors.ts";
import { addUsage, emptyUsage, newId, nowIso, type Usage } from "../shared/schemas/common.ts";
import {
  ACTIVE_JOB_STATUSES,
  Job,
  type JobStage,
  type JobStatus,
  type JobType,
} from "../shared/schemas/jobs.ts";
import { listDir, readJson, writeJson } from "../store/json.ts";
import type { DataPaths } from "../store/paths.ts";
import type { EventBus } from "./events.ts";

/** Thrown by handlers when they stop at a step boundary because a pause was requested. */
export class PauseSignal extends Error {
  constructor() {
    super("Paused");
    this.name = "PauseSignal";
  }
}

export interface JobContext {
  job: Job;
  signal: AbortSignal;
  /** True once the user asked to pause; handlers stop at the next step boundary. */
  pauseRequested(): boolean;
  /** Throws PauseSignal when a pause was requested. */
  checkpoint(): void;
  progress(done: number, total: number, label: string): void;
  addUsage(usage: Usage): void;
  /** Counts an item that failed without stopping the job. */
  itemError(): void;
  /** Shows a message as the current progress label and keeps it in the job's notes. */
  log(message: string): void;
  /** Declares the job's stages, in order; they all start as "waiting". */
  stages(list: { key: string; label: string; total?: number }[]): void;
  /** Updates one stage (counts, state). */
  stage(key: string, patch: Partial<Pick<JobStage, "done" | "total" | "state" | "label">>): void;
}

const MAX_NOTES = 60;

export type JobHandler = (ctx: JobContext) => Promise<void>;

interface Running {
  controller: AbortController;
  pause: boolean;
  promise: Promise<void>;
}

/**
 * Runs long work as persisted jobs. Jobs survive restarts as "interrupted"
 * and can be resumed; handlers must be idempotent (skip finished steps).
 */
export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Map<string, Running>();
  private readonly lastWrite = new Map<string, number>();
  private readonly paths: DataPaths;
  private readonly events: EventBus;
  private readonly handlers: Partial<Record<JobType, JobHandler>>;

  constructor(paths: DataPaths, events: EventBus, handlers: Partial<Record<JobType, JobHandler>>) {
    this.paths = paths;
    this.events = events;
    this.handlers = handlers;
  }

  /** Loads saved jobs; anything that was running when the server stopped becomes "interrupted". */
  async init(): Promise<void> {
    for (const name of await listDir(this.paths.jobsDir())) {
      if (!name.endsWith(".json")) continue;
      const job = await readJson(this.paths.job(name.slice(0, -5)), Job).catch(() => undefined);
      if (!job) continue;
      if ((ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status)) {
        job.status = "interrupted";
        await this.persist(job, true);
      }
      this.jobs.set(job.id, job);
    }
  }

  list(projectId?: string): Job[] {
    return [...this.jobs.values()]
      .filter((j) => !projectId || j.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** The active job for a target, if any. */
  activeFor(targetId: string): Job | undefined {
    return [...this.jobs.values()].find(
      (j) =>
        j.targetId === targetId && (ACTIVE_JOB_STATUSES as readonly string[]).includes(j.status),
    );
  }

  private async persist(job: Job, force = false): Promise<void> {
    const now = Date.now();
    const last = this.lastWrite.get(job.id) ?? 0;
    this.events.job(job);
    if (!force && now - last < 1000) return;
    this.lastWrite.set(job.id, now);
    await writeJson(this.paths.job(job.id), Job, job);
  }

  start(args: {
    type: JobType;
    projectId: string;
    targetKind: Job["targetKind"];
    targetId: string;
    params?: Record<string, unknown>;
    label?: string;
  }): Job {
    const active = this.activeFor(args.targetId);
    if (active)
      throw new Error(
        `Another job (${active.type}) is already running for this item. Wait for it or cancel it.`,
      );
    const job: Job = {
      schemaVersion: 1,
      id: newId("job"),
      type: args.type,
      projectId: args.projectId,
      targetKind: args.targetKind,
      targetId: args.targetId,
      status: "queued",
      progress: { done: 0, total: 0, label: args.label ?? "Waiting to start", stages: [] },
      notes: [],
      error: null,
      itemErrors: 0,
      usage: emptyUsage(),
      params: args.params ?? {},
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    void this.persist(job, true);
    this.launch(job);
    return job;
  }

  /** Re-runs a paused, interrupted or failed job from where it stopped. */
  resume(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("No such job.");
    if (this.running.has(id)) throw new Error("The job is already running.");
    const other = this.activeFor(job.targetId);
    if (other && other.id !== id) throw new Error("Another job is already running for this item.");
    if (
      !["paused", "interrupted", "failed", "done_with_errors", "cancelled"].includes(job.status)
    ) {
      throw new Error(`A ${job.status} job can't be resumed.`);
    }
    job.status = "queued";
    job.error = null;
    job.finishedAt = null;
    void this.persist(job, true);
    this.launch(job);
    return job;
  }

  pause(id: string): Job {
    const job = this.jobs.get(id);
    const run = this.running.get(id);
    if (!job || !run) throw new Error("The job isn't running.");
    run.pause = true;
    job.status = "pausing";
    void this.persist(job, true);
    return job;
  }

  cancel(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("No such job.");
    const run = this.running.get(id);
    if (run) {
      run.controller.abort();
    } else if (!["done", "cancelled"].includes(job.status)) {
      job.status = "cancelled";
      job.finishedAt = nowIso();
      void this.persist(job, true);
    }
    return job;
  }

  /** Waits for a running job to settle (tests and shutdown). */
  async wait(id: string): Promise<Job | undefined> {
    await this.running.get(id)?.promise;
    return this.jobs.get(id);
  }

  private launch(job: Job): void {
    const handler = this.handlers[job.type];
    const controller = new AbortController();
    const run: Running = { controller, pause: false, promise: Promise.resolve() };
    this.running.set(job.id, run);
    const ctx: JobContext = {
      job,
      signal: controller.signal,
      pauseRequested: () => run.pause,
      checkpoint: () => {
        if (run.pause) throw new PauseSignal();
      },
      progress: (done, total, label) => {
        job.progress = { ...job.progress, done, total, label };
        void this.persist(job);
      },
      addUsage: (usage) => {
        job.usage = addUsage(job.usage, usage);
        void this.persist(job);
      },
      itemError: () => {
        job.itemErrors++;
        void this.persist(job);
      },
      log: (message) => {
        job.progress = { ...job.progress, label: message };
        job.notes = [...job.notes, { at: nowIso(), message }].slice(-MAX_NOTES);
        void this.persist(job);
      },
      stages: (list) => {
        job.progress = {
          ...job.progress,
          stages: list.map((st) => {
            // On resume, keep what earlier runs counted for the same stage.
            const old = job.progress.stages.find((o) => o.key === st.key);
            return {
              key: st.key,
              label: st.label,
              done: old?.state === "done" ? old.done : 0,
              total: st.total ?? old?.total ?? 0,
              state: old?.state === "done" ? "done" : "waiting",
            };
          }),
        };
        void this.persist(job);
      },
      stage: (key, patch) => {
        job.progress = {
          ...job.progress,
          stages: job.progress.stages.map((st) => (st.key === key ? { ...st, ...patch } : st)),
        };
        void this.persist(job);
      },
    };
    run.promise = (async () => {
      job.status = "running";
      job.startedAt ??= nowIso();
      job.itemErrors = 0;
      await this.persist(job, true);
      let status: JobStatus = "done";
      try {
        if (!handler) throw new Error(`No handler for ${job.type} jobs.`);
        // AI requests made inside the handler are tagged with this job.
        await jobScope.run({ jobId: job.id }, () => handler(ctx));
        status = job.itemErrors > 0 ? "done_with_errors" : "done";
      } catch (error) {
        if (error instanceof PauseSignal) status = "paused";
        else if (controller.signal.aborted || isLlmError(error, "aborted")) status = "cancelled";
        else {
          status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        job.status = status;
        if (status !== "paused") job.finishedAt = nowIso();
        this.running.delete(job.id);
        await this.persist(job, true);
        this.events.changed(job.projectId, job.type, job.targetId);
      }
    })();
  }
}
