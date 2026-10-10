import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { loadSteps, phase2Estimate, ReviewFile } from "../../pipeline/phase2.ts";
import { phase3Estimate } from "../../pipeline/phase3-job.ts";
import { bookDetail, deleteBook, importBook, saveSetup, updateBook } from "../../services/books.ts";
import {
  acceptUnit,
  chaptersOverview,
  chapterUnits,
  decodeUnitKey,
  glossary,
  removeManualEdit,
  saveManualEdit,
  saveToc,
  tocView,
} from "../../services/translation.ts";
import { BookSetup } from "../../shared/schemas/epub.ts";
import { RefKbMode } from "../../shared/schemas/project.ts";
import { readJson } from "../../store/json.ts";
import type { AppContext } from "../context.ts";
import { HttpError, idParam, intParam, jsonBody } from "../http.ts";
import { fileField } from "./pairs.ts";

export function bookRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.post("/:pid/books", async (c) => {
    const pid = idParam(c, "pid");
    const form = await c.req.parseBody();
    const book = await importBook(app, pid, await fileField(form, "file"));
    app.events.changed(pid, "books", book.id);
    return c.json({ book }, 201);
  });

  r.get("/:pid/books/:bookId", async (c) =>
    c.json(await bookDetail(app, idParam(c, "pid"), idParam(c, "bookId"))),
  );

  r.patch("/:pid/books/:bookId", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const body = await jsonBody(
      c,
      z.object({
        title: z.string().max(300).optional(),
        pairIds: z.array(z.string()).optional(),
        refKbMode: RefKbMode.optional(),
        options: z
          .object({
            newIdentifier: z.boolean().optional(),
            removeEmbeddedFonts: z.boolean().optional(),
          })
          .optional(),
      }),
    );
    const book = await updateBook(app, pid, bookId, body);
    app.events.changed(pid, "books", bookId);
    return c.json({ book });
  });

  r.put("/:pid/books/:bookId/setup", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const setup = await saveSetup(app, pid, bookId, await jsonBody(c, BookSetup));
    app.events.changed(pid, "books", bookId);
    return c.json({ setup });
  });

  r.delete("/:pid/books/:bookId", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    if (app.runner.activeFor(bookId))
      throw new HttpError(409, "busy", "A job is running for this book.");
    await deleteBook(app, pid, bookId);
    app.events.changed(pid, "books", bookId);
    return c.json({ ok: true });
  });

  // Phase 2 ------------------------------------------------------------------

  r.get("/:pid/books/:bookId/phase2/estimate", async (c) =>
    c.json(await phase2Estimate(app, idParam(c, "pid"), idParam(c, "bookId"))),
  );

  r.get("/:pid/books/:bookId/phase2/steps", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    return c.json({
      steps: await loadSteps(app, pid, bookId),
      review:
        (await readJson(app.paths.phase2Review(pid, bookId), ReviewFile).catch(() => undefined)) ??
        null,
    });
  });

  const startPhase2 = (pid: string, bookId: string, params: Record<string, unknown>) => {
    app.settings.target("phase2.chapter");
    app.settings.target("phase2.review");
    return app.runner.start({
      type: "phase2",
      projectId: pid,
      targetKind: "book",
      targetId: bookId,
      params,
    });
  };

  r.post("/:pid/books/:bookId/phase2/run", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await app.projects.book(pid, bookId);
    return c.json({ job: startPhase2(pid, bookId, {}) }, 202);
  });

  r.post("/:pid/books/:bookId/phase2/rerun-from/:step", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await app.projects.book(pid, bookId);
    return c.json({ job: startPhase2(pid, bookId, { fromStep: intParam(c, "step") }) }, 202);
  });

  // Phase 3 ------------------------------------------------------------------

  r.get("/:pid/books/:bookId/phase3/estimate", async (c) =>
    c.json(await phase3Estimate(app, idParam(c, "pid"), idParam(c, "bookId"))),
  );

  r.post("/:pid/books/:bookId/phase3/run", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await app.projects.book(pid, bookId);
    app.settings.target("phase3.translate");
    const job = app.runner.start({
      type: "phase3",
      projectId: pid,
      targetKind: "book",
      targetId: bookId,
    });
    return c.json({ job }, 202);
  });

  r.get("/:pid/books/:bookId/chapters", async (c) =>
    c.json(await chaptersOverview(app, idParam(c, "pid"), idParam(c, "bookId"))),
  );

  r.get("/:pid/books/:bookId/chapters/:cid/units", async (c) =>
    c.json(await chapterUnits(app, idParam(c, "pid"), idParam(c, "bookId"), idParam(c, "cid"))),
  );

  const unitKey = (c: Parameters<typeof idParam>[0]) => decodeUnitKey(idParam(c, "ukey"));

  r.put("/:pid/books/:bookId/units/:ukey", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const body = await jsonBody(c, z.object({ text: z.string().max(200_000) }));
    await saveManualEdit(app, pid, bookId, unitKey(c), body.text);
    app.events.changed(pid, "phase3", bookId);
    return c.json({ ok: true });
  });

  r.delete("/:pid/books/:bookId/units/:ukey/edit", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await removeManualEdit(app, pid, bookId, unitKey(c));
    app.events.changed(pid, "phase3", bookId);
    return c.json({ ok: true });
  });

  r.post("/:pid/books/:bookId/units/:ukey/accept", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await acceptUnit(app, pid, bookId, unitKey(c));
    app.events.changed(pid, "phase3", bookId);
    return c.json({ ok: true });
  });

  const startRetranslate = (pid: string, bookId: string, params: Record<string, unknown>) => {
    app.settings.target("phase3.translate");
    return app.runner.start({
      type: "retranslate",
      projectId: pid,
      targetKind: "book",
      targetId: bookId,
      params,
    });
  };

  r.post("/:pid/books/:bookId/units/:ukey/retranslate", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const body = await jsonBody(
      c,
      z.object({ instruction: z.string().max(2000).nullable().default(null) }),
    );
    return c.json(
      {
        job: startRetranslate(pid, bookId, { unitKey: unitKey(c), instruction: body.instruction }),
      },
      202,
    );
  });

  r.post("/:pid/books/:bookId/chunks/:n/retranslate", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const body = await jsonBody(
      c,
      z.object({ instruction: z.string().max(2000).nullable().default(null) }),
    );
    return c.json(
      {
        job: startRetranslate(pid, bookId, {
          chunkIndex: intParam(c, "n"),
          instruction: body.instruction,
        }),
      },
      202,
    );
  });

  r.get("/:pid/books/:bookId/glossary", async (c) =>
    c.json(await glossary(app, idParam(c, "pid"), idParam(c, "bookId"))),
  );

  r.get("/:pid/books/:bookId/toc", async (c) =>
    c.json(await tocView(app, idParam(c, "pid"), idParam(c, "bookId"))),
  );

  r.put("/:pid/books/:bookId/toc", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const body = await jsonBody(
      c,
      z.object({ title: z.string().nullable(), items: z.record(z.string(), z.string()) }),
    );
    await saveToc(app, pid, bookId, body.title, body.items);
    return c.json({ ok: true });
  });

  // Build --------------------------------------------------------------------

  r.post("/:pid/books/:bookId/build", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await app.projects.book(pid, bookId);
    const body = await jsonBody(c, z.object({ useBestAttempts: z.boolean().default(false) }));
    const job = app.runner.start({
      type: "build",
      projectId: pid,
      targetKind: "book",
      targetId: bookId,
      params: body,
    });
    return c.json({ job }, 202);
  });

  r.get("/:pid/books/:bookId/build/report", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    return c.json({
      report:
        (await readJson(
          app.paths.buildReport(pid, bookId),
          z.record(z.string(), z.unknown()),
        ).catch(() => undefined)) ?? null,
    });
  });

  r.get("/:pid/books/:bookId/output", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const book = await app.projects.book(pid, bookId);
    if (!book.build.fileName) throw new HttpError(404, "not_built", "Build the book first.");
    const file = path.join(app.paths.outputDir(pid, bookId), book.build.fileName);
    const data = await fs.readFile(file);
    return new Response(data, {
      headers: {
        "content-type": "application/epub+zip",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(book.build.fileName)}`,
      },
    });
  });

  return r;
}
