import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppContext } from "./context.ts";
import { errorResponse } from "./http.ts";
import { bookRoutes } from "./routes/books.ts";
import { eventRoutes, jobRoutes, usageRoutes } from "./routes/jobs.ts";
import { kbRoutes } from "./routes/kb.ts";
import { pairRoutes } from "./routes/pairs.ts";
import { projectRoutes } from "./routes/projects.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { securityMiddleware } from "./security.ts";

export interface AppOptions {
  /** Serve the built web UI from this folder (production). */
  staticDir?: string;
}

export function createApp(ctx: AppContext, options: AppOptions = {}): Hono {
  const app = new Hono();
  app.onError((error, c) => errorResponse(c, error));

  app.use("/api/*", securityMiddleware({ port: ctx.port, devPorts: ctx.devPorts }));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 300 * 1024 * 1024,
      onError: (c) =>
        c.json({ error: { code: "too_large", message: "The upload is larger than 300 MB." } }, 413),
    }),
  );

  app.get("/api/health", (c) => c.json({ ok: true, version: "0.1.0" }));
  app.route("/api/settings", settingsRoutes(ctx));
  app.route("/api/projects", projectRoutes(ctx));
  app.route("/api/jobs", jobRoutes(ctx));
  app.route("/api/events", eventRoutes(ctx));
  app.route("/api/usage", usageRoutes(ctx));
  app.route("/api/projects", pairRoutes(ctx));
  app.route("/api/projects", bookRoutes(ctx));
  app.route("/api/projects", kbRoutes(ctx, "pair"));
  app.route("/api/projects", kbRoutes(ctx, "book"));

  app.all("/api/*", (c) =>
    c.json({ error: { code: "not_found", message: "Unknown API route." } }, 404),
  );

  if (options.staticDir) {
    const root = path.resolve(options.staticDir);
    app.get("*", async (c) => {
      const url = new URL(c.req.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = path.resolve(root, rel || "index.html");
      const safe = file.startsWith(root) ? file : path.join(root, "index.html");
      for (const candidate of [safe, path.join(root, "index.html")]) {
        try {
          const data = await fs.readFile(candidate);
          return new Response(data, { headers: { "content-type": contentType(candidate) } });
        } catch {
          // try the next candidate
        }
      }
      return c.text("Not found", 404);
    });
  }
  return app;
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".woff2": "font/woff2",
  };
  return types[ext] ?? "application/octet-stream";
}
