import { promises as fs } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { defaultDataDir } from "../store/paths.ts";
import { createApp, type WebFiles, webFolder } from "./app.ts";
import { createContext } from "./context.ts";
import { jobHandlers } from "./handlers.ts";
import { embeddedWeb, openBrowser, standalone, waitForEnter } from "./standalone.ts";

const hostname = "127.0.0.1";

// Under pnpm dev the pages come from Vite, which has the current code; a
// build left in dist/web would be out of date, so it isn't served then.
const dev = process.argv.includes("--dev");
// The standalone app opens the browser itself, unless started with --no-browser.
const browser = standalone && !process.argv.includes("--no-browser");

// The standalone app reads the .env next to it, as pnpm start reads the repo's.
const envFile = standalone ? path.join(path.dirname(process.execPath), ".env") : ".env";

async function main(): Promise<void> {
  if (standalone) loadEnvFile(envFile);
  const dataDir = defaultDataDir({ standalone });
  if (standalone) await checkWritable(dataDir);

  const port = Number(process.env.PORT ?? 5174);
  const url = `http://${hostname}:${port}`;
  // The Vite dev server's port, allowed as a browser origin (see vite.config.ts).
  const webPort = Number(process.env.WEB_PORT ?? 5173);

  // A second server would mark the first one's running jobs as interrupted.
  if (await alreadyRunning(url)) {
    console.log(`Trainslator is already running: ${url}`);
    if (browser) openBrowser(url);
    process.exit(standalone ? 0 : 1);
  }

  const ctx = await createContext({ dataDir, port, devPorts: [webPort], handlers: jobHandlers });
  const web = standalone ? embeddedWeb() : dev ? undefined : await builtWeb();
  const app = createApp(ctx, { web, devWebPort: dev ? webPort : undefined });

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    const note = dev
      ? ` (API; open the app at http://localhost:${webPort})`
      : web
        ? ""
        : " (API only; run the web UI with pnpm dev)";
    console.log(`Trainslator server: http://${hostname}:${info.port}${note}`);
    console.log(`Data folder: ${dataDir}`);
    if (standalone) console.log("Keep this window open while you use Trainslator.");
    if (browser) openBrowser(url);
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    void fail(
      error.code === "EADDRINUSE"
        ? `Port ${port} is in use by another program. Set PORT in ${envFile} to use another port.`
        : error,
    );
  });

  async function shutdown(): Promise<void> {
    await ctx.rt.calibration.flush().catch(() => {});
    process.exit(0);
  }
  // SIGHUP: the terminal was closed (on Windows, the console window).
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown());
  }
}

function loadEnvFile(file: string): void {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Fails early, with a message, when the data folder can't be written (under Program Files, say). */
async function checkWritable(dir: string): Promise<void> {
  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, "");
    await fs.rm(probe);
  } catch {
    throw new Error(
      `Trainslator can't write to its data folder, ${dir}. Move the program to a folder you own, or set TRAINSLATOR_DATA_DIR to one.`,
    );
  }
}

/** Whether a Trainslator server already answers at this address. */
async function alreadyRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** The web UI that pnpm build put in dist/web, if there is one. */
async function builtWeb(): Promise<WebFiles | undefined> {
  const dir = path.resolve("dist", "web");
  try {
    await fs.access(path.join(dir, "index.html"));
    return webFolder(dir);
  } catch {
    return undefined;
  }
}

/** Prints why the server stopped. A double-clicked program's window stays open until Enter. */
async function fail(error: unknown): Promise<never> {
  console.error(standalone && error instanceof Error ? error.message : error);
  if (standalone) await waitForEnter();
  process.exit(1);
}

main().catch(fail);
