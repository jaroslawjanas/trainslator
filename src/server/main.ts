import { promises as fs } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { defaultDataDir } from "../store/paths.ts";
import { createApp } from "./app.ts";
import { createContext } from "./context.ts";
import { jobHandlers } from "./handlers.ts";

const port = Number(process.env.PORT ?? 5174);
const hostname = "127.0.0.1";
const dataDir = defaultDataDir();

// The Vite dev server's port, allowed as a browser origin (see vite.config.ts).
const webPort = Number(process.env.WEB_PORT ?? 5173);

const ctx = await createContext({ dataDir, port, devPorts: [webPort], handlers: jobHandlers });

// Under pnpm dev the pages come from Vite, which has the current code; a
// build left in dist/web would be out of date, so it isn't served then.
const dev = process.argv.includes("--dev");
const webDir = path.resolve("dist", "web");
let staticDir: string | undefined;
try {
  if (!dev) {
    await fs.access(path.join(webDir, "index.html"));
    staticDir = webDir;
  }
} catch {
  staticDir = undefined;
}

const app = createApp(ctx, { staticDir, devWebPort: dev ? webPort : undefined });

serve({ fetch: app.fetch, port, hostname }, (info) => {
  const note = dev
    ? ` (API; open the app at http://localhost:${webPort})`
    : staticDir
      ? ""
      : " (API only; run the web UI with pnpm dev)";
  console.log(`Trainslator server: http://${hostname}:${info.port}${note}`);
  console.log(`Data folder: ${dataDir}`);
});

async function shutdown(): Promise<void> {
  await ctx.rt.calibration.flush().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
