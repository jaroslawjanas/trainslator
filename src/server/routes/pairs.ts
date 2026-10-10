import { Hono } from "hono";
import { z } from "zod";
import { phase1ChapterFindings, phase1Chapters, phase1Estimate } from "../../pipeline/phase1.ts";
import {
  aiProposeAlignment,
  deletePair,
  importPair,
  loadAlignment,
  pairDetail,
  reproposeAlignment,
  saveAlignment,
  unitPreview,
} from "../../services/pairs.ts";
import { Alignment } from "../../shared/schemas/alignment.ts";
import type { AppContext } from "../context.ts";
import { HttpError, idParam, intParam, jsonBody } from "../http.ts";

async function fileField(
  form: Record<string, unknown>,
  name: string,
): Promise<{ name: string; bytes: Uint8Array }> {
  const value = form[name];
  if (!(value instanceof File))
    throw new HttpError(400, "missing_file", `Upload the "${name}" EPUB file.`);
  return { name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) };
}

export { fileField };

export function pairRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.post("/:pid/pairs", async (c) => {
    const pid = idParam(c, "pid");
    const form = await c.req.parseBody();
    const pair = await importPair(app, pid, {
      source: await fileField(form, "source"),
      target: await fileField(form, "target"),
    });
    app.events.changed(pid, "pairs", pair.id);
    return c.json({ pair }, 201);
  });

  r.get("/:pid/pairs/:pairId", async (c) =>
    c.json(await pairDetail(app, idParam(c, "pid"), idParam(c, "pairId"))),
  );

  r.delete("/:pid/pairs/:pairId", async (c) => {
    const pid = idParam(c, "pid");
    const pairId = idParam(c, "pairId");
    if (app.runner.activeFor(pairId))
      throw new HttpError(409, "busy", "A job is running for this pair.");
    await deletePair(app, pid, pairId);
    app.events.changed(pid, "pairs", pairId);
    return c.json({ ok: true });
  });

  r.put("/:pid/pairs/:pairId/alignment", async (c) => {
    const pid = idParam(c, "pid");
    const pairId = idParam(c, "pairId");
    const alignment = await saveAlignment(app, pid, pairId, await jsonBody(c, Alignment));
    app.events.changed(pid, "alignment", pairId);
    return c.json({ alignment });
  });

  r.post("/:pid/pairs/:pairId/alignment/propose", async (c) => {
    const pid = idParam(c, "pid");
    const pairId = idParam(c, "pairId");
    const body = await jsonBody(
      c,
      z.object({ source: z.number().int().positive(), target: z.number().int().positive() }),
    );
    const alignment = await reproposeAlignment(app, pid, pairId, body);
    app.events.changed(pid, "alignment", pairId);
    return c.json({ alignment });
  });

  r.post("/:pid/pairs/:pairId/alignment/propose-ai", async (c) => {
    const pid = idParam(c, "pid");
    const pairId = idParam(c, "pairId");
    const body = await jsonBody(
      c,
      z.object({ source: z.number().int().positive(), target: z.number().int().positive() }),
    );
    const alignment = await aiProposeAlignment(app, pid, pairId, body);
    app.events.changed(pid, "alignment", pairId);
    return c.json({ alignment });
  });

  r.get("/:pid/pairs/:pairId/units/:uid/preview", async (c) =>
    c.json(await unitPreview(app, idParam(c, "pid"), idParam(c, "pairId"), idParam(c, "uid"))),
  );

  r.get("/:pid/pairs/:pairId/phase1/chapters", async (c) =>
    c.json(await phase1Chapters(app, idParam(c, "pid"), idParam(c, "pairId"))),
  );

  r.get("/:pid/pairs/:pairId/phase1/chapters/:position", async (c) =>
    c.json(
      await phase1ChapterFindings(
        app,
        idParam(c, "pid"),
        idParam(c, "pairId"),
        intParam(c, "position"),
      ),
    ),
  );

  r.get("/:pid/pairs/:pairId/phase1/estimate", async (c) =>
    c.json(await phase1Estimate(app, idParam(c, "pid"), idParam(c, "pairId"))),
  );

  r.post("/:pid/pairs/:pairId/phase1/run", async (c) => {
    const pid = idParam(c, "pid");
    const pairId = idParam(c, "pairId");
    await app.projects.pair(pid, pairId);
    const alignment = await loadAlignment(app, pid, pairId);
    if (alignment.status !== "confirmed")
      throw new HttpError(409, "not_confirmed", "Confirm the chapter alignment first.");
    app.settings.target("phase1.read");
    app.settings.target("phase1.merge");
    const job = app.runner.start({
      type: "phase1",
      projectId: pid,
      targetKind: "pair",
      targetId: pairId,
    });
    return c.json({ job }, 202);
  });

  return r;
}
