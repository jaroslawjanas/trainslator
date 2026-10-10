import { Hono } from "hono";
import { z } from "zod";
import { KIND_PRESETS } from "../../llm/presets.ts";
import { listModels, testModel } from "../../llm/probe.ts";
import { Connection, Model, StepSettingsMap } from "../../shared/schemas/settings.ts";
import { STEP_INFO } from "../../shared/steps.ts";
import type { AppContext } from "../context.ts";
import { HttpError, idParam, jsonBody } from "../http.ts";

export function settingsRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/", (c) =>
    c.json({ settings: app.settings.masked(), presets: KIND_PRESETS, steps: STEP_INFO }),
  );

  r.put("/connections/:id", async (c) => {
    const id = idParam(c, "id");
    const body = await jsonBody(c, Connection);
    if (body.id !== id)
      throw new HttpError(400, "id_mismatch", "The id in the URL and the body differ.");
    await app.settings.upsertConnection(body);
    return c.json({ settings: app.settings.masked() });
  });

  r.delete("/connections/:id", async (c) => {
    await app.settings.deleteConnection(idParam(c, "id"));
    return c.json({ settings: app.settings.masked() });
  });

  r.get("/connections/:id/models", async (c) => {
    const connection = app.settings.connection(idParam(c, "id"));
    if (!connection) throw new HttpError(404, "not_found", "Connection not found.");
    return c.json({ models: await listModels(app.rt, connection) });
  });

  r.post("/connections/:id/test", async (c) => {
    const connection = app.settings.connection(idParam(c, "id"));
    if (!connection) throw new HttpError(404, "not_found", "Connection not found.");
    const body = await jsonBody(
      c,
      z.object({ modelId: z.string(), deep: z.boolean().default(false) }),
    );
    const model = app.settings.model(body.modelId);
    if (!model || model.connectionId !== connection.id)
      throw new HttpError(404, "not_found", "Model not found on this connection.");
    return c.json({ report: await testModel(app.rt, connection, model, { deep: body.deep }) });
  });

  r.put("/models/:id", async (c) => {
    const id = idParam(c, "id");
    const body = await jsonBody(c, Model);
    if (body.id !== id)
      throw new HttpError(400, "id_mismatch", "The id in the URL and the body differ.");
    await app.settings.upsertModel(body);
    return c.json({ settings: app.settings.masked() });
  });

  r.delete("/models/:id", async (c) => {
    await app.settings.deleteModel(idParam(c, "id"));
    return c.json({ settings: app.settings.masked() });
  });

  r.put("/steps", async (c) => {
    const body = await jsonBody(c, StepSettingsMap);
    for (const s of Object.values(body)) {
      if (s.modelId && !app.settings.model(s.modelId))
        throw new HttpError(400, "unknown_model", "A step uses a model that doesn't exist.");
    }
    await app.settings.setSteps(body);
    return c.json({ settings: app.settings.masked() });
  });

  return r;
}
