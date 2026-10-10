import type { MiddlewareHandler } from "hono";

/**
 * The server only listens on 127.0.0.1, but any web page you visit can still
 * send requests to it. These checks stop that:
 * - Host must be this machine (blocks DNS rebinding),
 * - non-GET requests need an allowed Origin (blocks cross-site form posts),
 * - non-GET requests must be JSON, except uploads (blocks "simple" requests).
 */
export function securityMiddleware(options: {
  port: number;
  devPorts: number[];
}): MiddlewareHandler {
  const ports = [options.port, ...options.devPorts];
  const hosts = new Set(ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]));
  const origins = new Set(
    ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`]),
  );

  return async (c, next) => {
    const host = (c.req.header("host") ?? "").toLowerCase();
    if (!hosts.has(host)) {
      return c.json(
        {
          error: {
            code: "forbidden_host",
            message: "Requests must be made to this computer (localhost).",
          },
        },
        403,
      );
    }
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (!origin || !origins.has(origin.toLowerCase())) {
        return c.json(
          {
            error: {
              code: "forbidden_origin",
              message: "Requests must come from the Trainslator app.",
            },
          },
          403,
        );
      }
      // Browsers send cross-site "simple" requests as text/plain or form-encoded; only JSON
      // and uploads (multipart, which also needs the right Origin) are accepted.
      const type = (c.req.header("content-type") ?? "").toLowerCase();
      const isUpload = type.startsWith("multipart/form-data");
      const isJson = type.startsWith("application/json");
      if (type && !isJson && !isUpload) {
        return c.json(
          { error: { code: "bad_content_type", message: "Send JSON (application/json)." } },
          415,
        );
      }
    }
    await next();
  };
}
