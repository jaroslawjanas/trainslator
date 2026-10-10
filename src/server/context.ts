import { EventBus } from "../jobs/events.ts";
import { type JobHandler, JobRunner } from "../jobs/runner.ts";
import type { LlmRuntime } from "../llm/call.ts";
import { createLlmRuntime } from "../llm/runtime.ts";
import { BookCache } from "../services/books-cache.ts";
import { ProjectStore } from "../services/projects.ts";
import { SettingsService } from "../services/settings.ts";
import type { JobType } from "../shared/schemas/jobs.ts";
import { cleanupTempFiles } from "../store/json.ts";
import { DataPaths } from "../store/paths.ts";

/** Everything the routes and job handlers share. */
export interface AppContext {
  paths: DataPaths;
  settings: SettingsService;
  projects: ProjectStore;
  events: EventBus;
  runner: JobRunner;
  rt: LlmRuntime;
  books: BookCache;
  port: number;
  /** Extra allowed browser origins/hosts (the Vite dev server). */
  devPorts: number[];
}

export interface ContextOptions {
  dataDir: string;
  port: number;
  devPorts?: number[];
  handlers?: (ctx: AppContext) => Partial<Record<JobType, JobHandler>>;
  waits?: LlmRuntime["waits"];
}

export async function createContext(options: ContextOptions): Promise<AppContext> {
  const paths = new DataPaths(options.dataDir);
  await cleanupTempFiles(paths.root);
  const settings = new SettingsService(paths);
  await settings.load();
  const events = new EventBus();
  const rt = await createLlmRuntime(paths, {
    settings: () => settings.get(),
    waits: options.waits,
    // Full request and response bodies in logs/calls/, for debugging prompts.
    logBodies: () => process.env.TRAINSLATOR_LOG_BODIES === "1",
  });
  const ctx = {
    paths,
    settings,
    projects: new ProjectStore(paths),
    events,
    rt,
    books: new BookCache(),
    port: options.port,
    devPorts: options.devPorts ?? [5173],
  } as AppContext;
  ctx.runner = new JobRunner(paths, events, options.handlers?.(ctx) ?? {});
  await ctx.runner.init();
  return ctx;
}
