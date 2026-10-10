import { Hono } from "hono";
import { z } from "zod";
import {
  addEntry,
  addStyleRule,
  answerQuestion,
  editEntry,
  type KbScope,
  loadKb,
  preview,
  removeEntry,
  removeStyleRule,
  saveStyleRule,
  saveUnlocked,
  unlock,
} from "../../services/kb.ts";
import { askAboutEntry } from "../../services/kb-ask.ts";
import {
  KbEntry,
  KbKind,
  KbStatus,
  KbTreatment,
  KeyValue,
  StyleRule,
} from "../../shared/schemas/kb.ts";
import type { AppContext } from "../context.ts";
import { HttpError, idParam, jsonBody } from "../http.ts";

const NewEntry = z.object({
  kind: KbKind,
  source: z.string().min(1),
  aliases: z.array(z.string()),
  target: z.string().nullable(),
  targetSeen: z.array(z.string()),
  treatment: KbTreatment.nullable(),
  attributes: z.array(KeyValue),
  note: z.string(),
  examples: z.array(z.object({ source: z.string(), target: z.string().nullable() })),
  status: KbStatus,
  question: z.string().nullable(),
});

/** KB routes for one kind of owner ("pairs" or "books"). */
export function kbRoutes(app: AppContext, kind: "pair" | "book"): Hono {
  const r = new Hono();
  const segment = kind === "pair" ? "pairs" : "books";
  const scope = (c: Parameters<typeof idParam>[0]): KbScope => ({
    kind,
    pid: idParam(c, "pid"),
    id: idParam(c, "id"),
  });
  const changed = (s: KbScope) => app.events.changed(s.pid, "kb", s.id);

  r.get(`/:pid/${segment}/:id/kb`, async (c) => c.json(await loadKb(app, scope(c))));

  r.get(`/:pid/${segment}/:id/kb/preview`, async (c) => c.json(await preview(app, scope(c))));

  r.post(`/:pid/${segment}/:id/kb/entries`, async (c) => {
    const s = scope(c);
    const kb = await addEntry(app, s, await jsonBody(c, NewEntry));
    changed(s);
    return c.json({ kb }, 201);
  });

  r.put(`/:pid/${segment}/:id/kb/entries/:eid`, async (c) => {
    const s = scope(c);
    const entry = await jsonBody(c, KbEntry);
    if (entry.id !== idParam(c, "eid"))
      throw new HttpError(400, "id_mismatch", "The id in the URL and the body differ.");
    const kb = await editEntry(app, s, entry);
    changed(s);
    return c.json({ kb });
  });

  // Your changes without locking: later runs may still change the entry.
  r.put(`/:pid/${segment}/:id/kb/entries/:eid/unlocked`, async (c) => {
    const s = scope(c);
    const entry = await jsonBody(c, KbEntry);
    if (entry.id !== idParam(c, "eid"))
      throw new HttpError(400, "id_mismatch", "The id in the URL and the body differ.");
    const kb = await saveUnlocked(app, s, entry);
    changed(s);
    return c.json({ kb });
  });

  r.post(`/:pid/${segment}/:id/kb/entries/:eid/unlock`, async (c) => {
    const s = scope(c);
    const kb = await unlock(app, s, idParam(c, "eid"));
    changed(s);
    return c.json({ kb });
  });

  r.delete(`/:pid/${segment}/:id/kb/entries/:eid`, async (c) => {
    const s = scope(c);
    const kb = await removeEntry(app, s, idParam(c, "eid"));
    changed(s);
    return c.json({ kb });
  });

  r.post(`/:pid/${segment}/:id/kb/entries/:eid/answer`, async (c) => {
    const s = scope(c);
    const body = await jsonBody(
      c,
      z.object({
        target: z.string().nullable(),
        note: z.string().nullable(),
        attributes: z.array(KeyValue).nullable(),
      }),
    );
    const kb = await answerQuestion(app, s, idParam(c, "eid"), body);
    changed(s);
    return c.json({ kb });
  });

  // A model's proposal for an open question; nothing is saved.
  r.post(`/:pid/${segment}/:id/kb/entries/:eid/ask`, async (c) => {
    const body = await jsonBody(c, z.object({ modelId: z.string() }));
    return c.json(await askAboutEntry(app, scope(c), idParam(c, "eid"), body.modelId));
  });

  r.post(`/:pid/${segment}/:id/kb/style-rules`, async (c) => {
    const s = scope(c);
    const body = await jsonBody(c, z.object({ rule: z.string().min(1).max(2000) }));
    const kb = await addStyleRule(app, s, body.rule);
    changed(s);
    return c.json({ kb }, 201);
  });

  r.put(`/:pid/${segment}/:id/kb/style-rules/:rid`, async (c) => {
    const s = scope(c);
    const rule = await jsonBody(c, StyleRule);
    if (rule.id !== idParam(c, "rid"))
      throw new HttpError(400, "id_mismatch", "The id in the URL and the body differ.");
    const kb = await saveStyleRule(app, s, rule);
    changed(s);
    return c.json({ kb });
  });

  r.delete(`/:pid/${segment}/:id/kb/style-rules/:rid`, async (c) => {
    const s = scope(c);
    const kb = await removeStyleRule(app, s, idParam(c, "rid"));
    changed(s);
    return c.json({ kb });
  });

  return r;
}
