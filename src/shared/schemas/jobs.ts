import { z } from "zod";
import { Id, IsoDate, SchemaVersion, Usage } from "./common.ts";

export const JobType = z.enum([
  "language-notes",
  "phase1",
  "phase2",
  "phase3",
  "retranslate",
  "build",
]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum([
  "queued",
  "running",
  "pausing",
  "paused",
  "interrupted",
  "cancelled",
  "failed",
  "done",
  "done_with_errors",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "pausing"];
export const RESUMABLE_JOB_STATUSES: readonly JobStatus[] = ["paused", "interrupted", "failed"];

/** A named part of a job, e.g. "Reading chapter pairs: 12 of 61". */
export const JobStage = z.object({
  key: z.string(),
  label: z.string(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  state: z.enum(["waiting", "running", "done", "skipped"]),
});
export type JobStage = z.infer<typeof JobStage>;

export const Job = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  type: JobType,
  projectId: Id,
  targetKind: z.enum(["project", "pair", "book"]),
  targetId: Id,
  status: JobStatus,
  progress: z.object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    label: z.string(),
    stages: z.array(JobStage).default([]),
  }),
  /** Recent messages from the job (retries, splits, skipped items), newest last. */
  notes: z.array(z.object({ at: IsoDate, message: z.string() })).default([]),
  error: z.string().nullable(),
  /** Items that failed or were refused without stopping the job. */
  itemErrors: z.number().int().nonnegative(),
  usage: Usage,
  params: z.record(z.string(), z.unknown()),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
});
export type Job = z.infer<typeof Job>;

export const JobEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job"), job: Job }),
  z.object({
    type: z.literal("changed"),
    projectId: Id,
    /** What changed, used by the UI to refresh queries: e.g. "kb", "alignment", "phase3". */
    topic: z.string(),
    targetId: Id.nullable(),
  }),
]);
export type JobEvent = z.infer<typeof JobEvent>;
