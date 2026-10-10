import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { CallLogEntry } from "../../llm/log.ts";
import { addUsage, emptyUsage, type Usage } from "../../shared/schemas/common.ts";
import type { JobEvent } from "../../shared/schemas/jobs.ts";
import type { AppContext } from "../context.ts";
import { HttpError, idParam } from "../http.ts";

export function jobRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const projectId = c.req.query("projectId");
    return c.json({ jobs: app.runner.list(projectId || undefined).slice(0, 200) });
  });

  /** Finished requests from before this server started, read from the log once per job. */
  const fromLog = new Map<string, CallLogEntry[]>();

  // A job's requests: waiting or running now, and finished (newest first).
  r.get("/:id/activity", async (c) => {
    const id = idParam(c, "id");
    const job = app.runner.get(id);
    if (!job) throw new HttpError(404, "not_found", "No such job.");
    if (!fromLog.has(id)) {
      const logged = await app.rt.log.read(job.projectId).catch(() => []);
      fromLog.set(
        id,
        logged.filter((e) => e.jobId === id),
      );
    }
    const byId = new Map<string, CallLogEntry>();
    for (const e of fromLog.get(id) ?? []) byId.set(e.id, e);
    for (const e of app.rt.activity.finishedFor(id) ?? []) byId.set(e.id, e);
    const finished = [...byId.values()]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 400)
      .map((e) => ({
        id: e.id,
        at: e.at,
        step: e.step,
        label: e.label,
        modelName: e.modelName,
        attempt: e.attempt,
        kind: e.kind,
        finishReason: e.finishReason,
        latencyMs: e.latencyMs,
        waitMs: e.waitMs,
        promptTokens: e.usage.promptTokens,
        cachedTokens: e.usage.cachedTokens,
        completionTokens: e.usage.completionTokens,
        error: e.error,
      }));
    return c.json({ active: app.rt.activity.activeFor(id), finished });
  });

  const action = (name: "pause" | "resume" | "cancel") =>
    r.post(`/:id/${name}`, (c) => {
      const id = idParam(c, "id");
      try {
        const job =
          name === "pause"
            ? app.runner.pause(id)
            : name === "resume"
              ? app.runner.resume(id)
              : app.runner.cancel(id);
        return c.json({ job });
      } catch (error) {
        throw new HttpError(409, "job_state", (error as Error).message);
      }
    });
  action("pause");
  action("resume");
  action("cancel");

  return r;
}

export function eventRoutes(app: AppContext): Hono {
  const r = new Hono();
  r.get("/", (c) =>
    streamSSE(c, async (stream) => {
      const queue: JobEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = app.events.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (!stream.aborted) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          // A keepalive at least this often: the page reconnects when they stop.
          setTimeout(resolve, 10_000);
        });
        wake = null;
        if (queue.length === 0 && !stream.aborted)
          await stream.writeSSE({ event: "ping", data: "{}" });
      }
      unsubscribe();
    }),
  );
  return r;
}

export function usageRoutes(app: AppContext): Hono {
  const r = new Hono();
  r.get("/:pid", async (c) => {
    const pid = idParam(c, "pid");
    const { usageResetAt: since } = await app.projects.get(pid);
    // Claude Code runs on the subscription: its requests cost nothing, also
    // those logged before that was so.
    const settings = app.settings.get();
    const subscription = new Set(
      settings.models
        .filter(
          (m) => settings.connections.find((x) => x.id === m.connectionId)?.kind === "claude_code",
        )
        .map((m) => m.id),
    );
    const calls = (await app.rt.log.read(pid))
      .filter((call) => !since || call.at >= since)
      .map((call) =>
        subscription.has(call.modelId) ? { ...call, usage: { ...call.usage, cost: 0 } } : call,
      );
    const byStep = new Map<string, Usage & { cacheHits: number }>();
    let total = emptyUsage();
    for (const call of calls) {
      // The advisor gets its own row, whichever step asked it.
      const key = call.params.advisor === true ? "advisor" : call.step;
      const current = byStep.get(key) ?? { ...emptyUsage(), cacheHits: 0 };
      const next = {
        ...addUsage(current, call.usage),
        cacheHits: current.cacheHits + (call.kind === "cache_hit" ? 1 : 0),
      };
      byStep.set(key, next);
      total = addUsage(total, call.usage);
    }
    return c.json({
      since,
      total,
      byStep: Object.fromEntries(byStep),
      recent: calls.slice(-100).reverse(),
    });
  });
  r.post("/:pid/reset", async (c) => {
    const project = await app.projects.resetUsage(idParam(c, "pid"));
    return c.json({ since: project.usageResetAt });
  });
  return r;
}
