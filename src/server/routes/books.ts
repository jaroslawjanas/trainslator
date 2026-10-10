import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { loadSteps, phase2Estimate, ReviewFile, readOverrides } from "../../pipeline/phase2.ts";
import { phase3Estimate, preparedFor } from "../../pipeline/phase3-job.ts";
import {
  bookDetail,
  deleteBook,
  importBook,
  liveBook,
  saveSetup,
  updateBook,
} from "../../services/books.ts";
import {
  historyView,
  restoreKnowledge,
  restoreTranslation,
  savedBuildFile,
  saveTranslation,
} from "../../services/history.ts";
import { UserError } from "../../services/projects.ts";
import {
  CURRENT,
  editVersionUnit,
  replaceInReview,
  revertVersionUnit,
  reviewChapters,
  reviewUnits,
  rewritePassage,
  searchReview,
} from "../../services/review.ts";
import {
  acceptUnit,
  chaptersOverview,
  chapterUnits,
  decodeUnitKey,
  glossary,
  loadPlan,
  removeManualEdit,
  saveManualEdit,
  saveToc,
  tocView,
} from "../../services/translation.ts";
import { ID_RE } from "../../shared/schemas/common.ts";
import { BookSetup } from "../../shared/schemas/epub.ts";
import { RefKbMode, TranslationMode } from "../../shared/schemas/project.ts";
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
        translationMode: TranslationMode.optional(),
        options: z
          .object({
            newIdentifier: z.boolean().optional(),
            removeEmbeddedFonts: z.boolean().optional(),
          })
          .optional(),
      }),
    );
    const active = app.runner.activeFor(bookId);
    if (body.translationMode && (active?.type === "phase3" || active?.type === "retranslate"))
      throw new HttpError(409, "busy", "Wait for the translation to finish before switching.");
    const before = await app.projects.book(pid, bookId);
    const book = await updateBook(app, pid, bookId, body);
    if (book.translationMode !== before.translationMode) {
      // Re-plan now, so the chapter list never reads a plan that is being rewritten.
      // Without a translation model this waits for the next run.
      await preparedFor(app, pid, bookId, null).catch(() => undefined);
    }
    app.events.changed(pid, "books", bookId);
    return c.json({ book: liveBook(app, book) });
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
    // `again`: run the final review again even if nothing changed.
    const body = await jsonBody(c, z.object({ again: z.boolean().default(false) }), {
      optional: true,
    });
    return c.json({ job: startPhase2(pid, bookId, body.again ? { again: true } : {}) }, 202);
  });

  /** Reads the whole book again from an empty knowledge base, after saving the current one. */
  r.post("/:pid/books/:bookId/phase2/rebuild", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await app.projects.book(pid, bookId);
    const body = await jsonBody(c, z.object({ dropOwn: z.boolean().default(false) }), {
      optional: true,
    });
    return c.json({ job: startPhase2(pid, bookId, { rebuild: true, dropOwn: body.dropOwn }) }, 202);
  });

  /** How many of the knowledge base's entries and rules are your own changes. */
  r.get("/:pid/books/:bookId/phase2/own-changes", async (c) => {
    const overrides = await readOverrides(app, idParam(c, "pid"), idParam(c, "bookId"));
    const entries = Object.values(overrides.entries);
    return c.json({
      entries: entries.filter((e) => e.entry !== null).length,
      deletions: entries.filter((e) => e.entry === null).length,
      styleRules: Object.keys(overrides.styleRules).length,
    });
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

  // Review: versions side by side ---------------------------------------------

  r.get("/:pid/books/:bookId/review/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const versions = (c.req.query("versions") ?? "").split(",").filter(Boolean);
    const chapter = c.req.query("chapter") || null;
    if (!q || q.length > 200)
      throw new HttpError(400, "bad_request", "Search for 1 to 200 characters.");
    if (versions.length === 0 || versions.length > 3 || !versions.every((v) => ID_RE.test(v)))
      throw new HttpError(400, "bad_request", "Choose one to three versions to search.");
    if (chapter && !ID_RE.test(chapter))
      throw new HttpError(400, "bad_request", "Invalid chapter.");
    const options = {
      exact: c.req.query("exact") === "1",
      wholeWord: c.req.query("words") === "1",
    };
    return c.json(
      await searchReview(
        app,
        idParam(c, "pid"),
        idParam(c, "bookId"),
        q,
        versions,
        chapter,
        options,
      ),
    );
  });

  r.post("/:pid/books/:bookId/review/replace", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const body = await jsonBody(
      c,
      z.object({
        query: z.string().trim().min(1).max(200),
        replacement: z.string().max(2000),
        versions: z.array(z.string().regex(ID_RE)).min(1).max(3),
        chapterId: z.string().regex(ID_RE).nullable().default(null),
        key: z.string().nullable().default(null),
        exact: z.boolean().default(false),
        wholeWord: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      }),
    );
    const result = await replaceInReview(app, pid, bookId, {
      ...body,
      options: { exact: body.exact, wholeWord: body.wholeWord },
    });
    if (!body.dryRun) app.events.changed(pid, "phase3", bookId);
    return c.json(result);
  });

  r.get("/:pid/books/:bookId/review/chapters", async (c) => {
    const versions = (c.req.query("versions") ?? "").split(",").filter(Boolean);
    if (versions.length > 3 || !versions.every((v) => ID_RE.test(v)))
      throw new HttpError(400, "bad_request", "Choose up to three versions.");
    return c.json(await reviewChapters(app, idParam(c, "pid"), idParam(c, "bookId"), versions));
  });

  r.get("/:pid/books/:bookId/chapters/:cid/review", async (c) => {
    const versions = (c.req.query("versions") ?? CURRENT).split(",").filter(Boolean);
    if (versions.length === 0 || versions.length > 3 || !versions.every((v) => ID_RE.test(v)))
      throw new HttpError(400, "bad_request", "Choose one to three versions.");
    return c.json(
      await reviewUnits(app, idParam(c, "pid"), idParam(c, "bookId"), idParam(c, "cid"), versions),
    );
  });

  r.put("/:pid/books/:bookId/versions/:vid/units/:ukey", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const body = await jsonBody(c, z.object({ text: z.string().max(200_000) }));
    await editVersionUnit(app, pid, bookId, idParam(c, "vid"), unitKey(c), body.text);
    app.events.changed(pid, "phase3", bookId);
    return c.json({ ok: true });
  });

  r.delete("/:pid/books/:bookId/versions/:vid/units/:ukey/edit", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await revertVersionUnit(app, pid, bookId, idParam(c, "vid"), unitKey(c));
    app.events.changed(pid, "phase3", bookId);
    return c.json({ ok: true });
  });

  r.post("/:pid/books/:bookId/units/:ukey/rewrite", async (c) => {
    const body = await jsonBody(
      c,
      z.object({
        version: z.string().regex(ID_RE),
        text: z.string().max(200_000),
        selection: z
          .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
          .nullable()
          .default(null),
        modelId: z.string(),
        context: z.boolean().default(false),
        knowledgeBases: z.boolean().default(true),
        instruction: z.string().max(2000).nullable().default(null),
      }),
    );
    return c.json(
      await rewritePassage(app, idParam(c, "pid"), idParam(c, "bookId"), unitKey(c), body),
    );
  });

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

  r.post("/:pid/books/:bookId/phase3/redo", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    await app.projects.book(pid, bookId);
    app.settings.target("phase3.translate");
    const job = app.runner.start({
      type: "phase3",
      projectId: pid,
      targetKind: "book",
      targetId: bookId,
      params: { fresh: true },
    });
    return c.json({ job }, 202);
  });

  // History ------------------------------------------------------------------

  r.get("/:pid/books/:bookId/history", async (c) =>
    c.json(await historyView(app, idParam(c, "pid"), idParam(c, "bookId"))),
  );

  r.post("/:pid/books/:bookId/history/translations", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    const id = await saveTranslation(app, pid, bookId, "manual");
    if (!id) throw new UserError("Nothing is translated yet.");
    app.events.changed(pid, "phase3", bookId);
    return c.json({ id });
  });

  r.post("/:pid/books/:bookId/history/translations/:tid/restore", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    if (app.runner.activeFor(bookId))
      throw new HttpError(409, "busy", "Wait for the running job to finish before restoring.");
    // The current plan, so the passages land in the chunks the book uses now.
    const plan =
      (await preparedFor(app, pid, bookId, null).then(
        (p) => p.prepared.plan,
        () => null,
      )) ?? (await loadPlan(app, pid, bookId));
    if (!plan) throw new UserError("Choose a model for translation in Settings first.");
    await restoreTranslation(app, pid, bookId, idParam(c, "tid"), plan);
    app.events.changed(pid, "phase3", bookId);
    app.events.changed(pid, "books", bookId);
    return c.json({ ok: true });
  });

  r.post("/:pid/books/:bookId/history/knowledge/:kid/restore", async (c) => {
    const pid = idParam(c, "pid");
    const bookId = idParam(c, "bookId");
    if (app.runner.activeFor(bookId))
      throw new HttpError(409, "busy", "Wait for the running job to finish before restoring.");
    await restoreKnowledge(app, pid, bookId, idParam(c, "kid"));
    app.events.changed(pid, "kb", bookId);
    app.events.changed(pid, "books", bookId);
    return c.json({ ok: true });
  });

  r.get("/:pid/books/:bookId/history/builds/:id", async (c) => {
    const { build, data } = await savedBuildFile(
      app,
      idParam(c, "pid"),
      idParam(c, "bookId"),
      idParam(c, "id"),
    );
    return new Response(data, {
      headers: {
        "content-type": "application/epub+zip",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(build.fileName)}`,
      },
    });
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
