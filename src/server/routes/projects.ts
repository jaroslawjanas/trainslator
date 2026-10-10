import { Hono } from "hono";
import { z } from "zod";
import { COMMON_LANGUAGES, languageDisplayName } from "../../shared/languages.ts";
import type { AppContext } from "../context.ts";
import { HttpError, idParam, jsonBody } from "../http.ts";

export function projectRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/languages", (c) =>
    c.json({ languages: COMMON_LANGUAGES.map((tag) => ({ tag, name: languageDisplayName(tag) })) }),
  );

  r.get("/", async (c) => {
    const projects = await app.projects.list();
    const withCounts = await Promise.all(
      projects.map(async (p) => ({
        ...p,
        pairCount: (await app.projects.pairs(p.id)).length,
        bookCount: (await app.projects.books(p.id)).length,
      })),
    );
    return c.json({ projects: withCounts });
  });

  r.post("/", async (c) => {
    const body = await jsonBody(
      c,
      z.object({ name: z.string().max(200), targetLang: z.string().min(2).max(40) }),
    );
    const project = await app.projects.create(body);
    return c.json({ project }, 201);
  });

  r.get("/:pid", async (c) => {
    const pid = idParam(c, "pid");
    const project = await app.projects.get(pid);
    return c.json({
      project,
      pairs: await app.projects.pairs(pid),
      books: await app.projects.books(pid),
      languageNotes: await app.projects.languageNotes(pid),
      jobs: app.runner.list(pid).slice(0, 50),
    });
  });

  r.patch("/:pid", async (c) => {
    const pid = idParam(c, "pid");
    const body = await jsonBody(
      c,
      z.object({ name: z.string().max(200).optional(), pauseAfterPhase: z.boolean().optional() }),
    );
    const project = await app.projects.update(pid, body);
    app.events.changed(pid, "project", pid);
    return c.json({ project });
  });

  r.delete("/:pid", async (c) => {
    const pid = idParam(c, "pid");
    if (app.runner.list(pid).some((j) => ["queued", "running", "pausing"].includes(j.status))) {
      throw new HttpError(409, "busy", "Stop the project's running jobs before deleting it.");
    }
    await app.projects.delete(pid);
    return c.json({ ok: true });
  });

  r.get("/:pid/language-notes", async (c) =>
    c.json({ markdown: await app.projects.languageNotes(idParam(c, "pid")) }),
  );

  r.put("/:pid/language-notes", async (c) => {
    const pid = idParam(c, "pid");
    const body = await jsonBody(c, z.object({ markdown: z.string().max(50_000) }));
    await app.projects.setLanguageNotes(pid, body.markdown);
    app.events.changed(pid, "language-notes", pid);
    return c.json({ ok: true });
  });

  r.post("/:pid/language-notes/generate", async (c) => {
    const pid = idParam(c, "pid");
    await app.projects.get(pid);
    app.settings.target("utility");
    const job = app.runner.start({
      type: "language-notes",
      projectId: pid,
      targetKind: "project",
      targetId: pid,
    });
    return c.json({ job }, 202);
  });

  r.post("/:pid/cache/clear", async (c) => {
    const removed = await app.rt.cache.clear(idParam(c, "pid"));
    return c.json({ removed });
  });

  return r;
}
