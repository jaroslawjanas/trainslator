import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
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
          setTimeout(resolve, 15_000);
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
    const calls = await app.rt.log.read(pid);
    const byStep = new Map<string, Usage & { cacheHits: number }>();
    let total = emptyUsage();
    for (const call of calls) {
      const current = byStep.get(call.step) ?? { ...emptyUsage(), cacheHits: 0 };
      const next = {
        ...addUsage(current, call.usage),
        cacheHits: current.cacheHits + (call.kind === "cache_hit" ? 1 : 0),
      };
      byStep.set(call.step, next);
      total = addUsage(total, call.usage);
    }
    return c.json({
      total,
      byStep: Object.fromEntries(byStep),
      recent: calls.slice(-100).reverse(),
    });
  });
  return r;
}
