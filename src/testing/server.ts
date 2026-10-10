import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { createApp } from "../server/app.ts";
import { type AppContext, createContext } from "../server/context.ts";
import { jobHandlers } from "../server/handlers.ts";

export interface TestServer {
  app: Hono;
  ctx: AppContext;
  dir: string;
  /** Sends a request the way the browser app does (allowed host and origin). */
  call(method: string, url: string, body?: unknown): Promise<Response>;
  json<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<T>;
  cleanup(): Promise<void>;
}

export async function makeTestServer(): Promise<TestServer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trainslator-srv-"));
  const ctx = await createContext({
    dataDir: dir,
    port: 5174,
    handlers: jobHandlers,
    waits: { rateLimitMs: 10, transportMs: 10 },
  });
  const app = createApp(ctx);
  const call = async (method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = { host: "127.0.0.1:5174" };
    let payload: string | FormData | undefined;
    if (method !== "GET") headers.origin = "http://127.0.0.1:5174";
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return app.request(url, { method, headers, body: payload });
  };
  return {
    app,
    ctx,
    dir,
    call,
    async json<T>(method: string, url: string, body?: unknown): Promise<T> {
      const res = await call(method, url, body);
      const data = (await res.json()) as T & { error?: { message: string } };
      if (!res.ok) throw new Error(`${res.status} ${data.error?.message ?? ""}`);
      return data;
    },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
