import type { JobHandler } from "../jobs/runner.ts";
import { phase1Job } from "../pipeline/phase1.ts";
import { phase2Job } from "../pipeline/phase2.ts";
import { buildJob, phase3Job, retranslateJob } from "../pipeline/phase3-job.ts";
import { languageNotesJob } from "../pipeline/project.ts";
import type { JobType } from "../shared/schemas/jobs.ts";
import type { AppContext } from "./context.ts";

/** Job types and the functions that run them. */
export function jobHandlers(app: AppContext): Partial<Record<JobType, JobHandler>> {
  return {
    "language-notes": (job) => languageNotesJob(app, job),
    phase1: (job) => phase1Job(app, job),
    phase2: (job) => phase2Job(app, job),
    phase3: (job) => phase3Job(app, job),
    retranslate: (job) => retranslateJob(app, job),
    build: (job) => buildJob(app, job),
  };
}
