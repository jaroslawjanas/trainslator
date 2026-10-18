/**
 * Builds the standalone app for the system this runs on: one program with
 * Node, the server and the web UI in it (Node's single executable
 * applications), then starts it once to check that it serves the app.
 * `pnpm package` runs `pnpm build` first.
 *
 *   node scripts/package.ts
 *
 * Writes dist/standalone/trainslator (trainslator.exe on Windows).
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { build } from "rolldown";
import { parseAst } from "rolldown/parseAst";

const WEB_DIR = path.resolve("dist", "web");
const OUT_DIR = path.resolve("dist", "standalone");
const PROGRAM = path.join(
  OUT_DIR,
  process.platform === "win32" ? "trainslator.exe" : "trainslator",
);
const MAC = process.platform === "darwin";

// postject has no type declarations.
const postject = createRequire(import.meta.url)("postject") as {
  inject(
    file: string,
    resource: string,
    data: Buffer,
    options: { sentinelFuse: string; machoSegmentName?: string },
  ): Promise<void>;
};

/** import() expressions in a syntax tree; text in strings and comments doesn't count. */
function countImports(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, child) => sum + countImports(child), 0);
  if (!node || typeof node !== "object") return 0;
  const self = (node as { type?: unknown }).type === "ImportExpression" ? 1 : 0;
  return Object.values(node).reduce((sum: number, child) => sum + countImports(child), self);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? `exit code ${result.status}`}`);
}

try {
  await fs.access(path.join(WEB_DIR, "index.html"));
} catch {
  throw new Error("dist/web has no web UI. Run pnpm build first, or use pnpm package.");
}
await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

// 1. The server and its dependencies in one CommonJS file: the program's main
//    script can only require Node's own modules.
const mainFile = path.join(OUT_DIR, "main.cjs");
await build({
  input: "src/server/main.ts",
  platform: "node",
  logLevel: "warn",
  output: {
    file: mainFile,
    format: "cjs",
    codeSplitting: false,
    // Node's own modules that the SDKs load lazily with import(): the main
    // script can't run import(), so these become require() calls.
    dynamicImportInCjs: false,
    comments: { legal: true, annotation: false, jsdoc: false },
  },
});
// A leftover import() would only fail at its first use, perhaps the first AI request.
const leftover = countImports(parseAst(await fs.readFile(mainFile, "utf8")));
if (leftover > 0) throw new Error(`The bundle still has ${leftover} dynamic import(s).`);

// 2. The blob Node writes into the program: the main script, and the web UI as assets.
const assets: Record<string, string> = {};
for (const entry of await fs.readdir(WEB_DIR, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  assets[`web/${path.relative(WEB_DIR, file).split(path.sep).join("/")}`] = file;
}
const blob = path.join(OUT_DIR, "sea-prep.blob");
const config = path.join(OUT_DIR, "sea-config.json");
await fs.writeFile(
  config,
  JSON.stringify(
    { main: mainFile, output: blob, disableExperimentalSEAWarning: true, assets },
    null,
    2,
  ),
);
run(process.execPath, ["--experimental-sea-config", config]);

// 3. A copy of this Node with the blob in it. macOS needs the signature removed
//    first and an ad-hoc one added after: Apple Silicon runs nothing unsigned.
await fs.copyFile(process.execPath, PROGRAM);
await fs.chmod(PROGRAM, 0o755);
if (MAC) run("codesign", ["--remove-signature", PROGRAM]);
await postject.inject(PROGRAM, "NODE_SEA_BLOB", await fs.readFile(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  machoSegmentName: MAC ? "NODE_SEA" : undefined,
});
if (MAC) run("codesign", ["--sign", "-", PROGRAM]);

// 4. Start it on a free port with an empty data folder, and check that it
//    serves the API, the page and the page's script.
await smokeTest();
const { size } = await fs.stat(PROGRAM);
console.log(
  `Built ${path.relative(process.cwd(), PROGRAM)} (${Math.round(size / 1e6)} MB); it starts and serves the app.`,
);

async function smokeTest(): Promise<void> {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "trainslator-smoke-"));
  const child = spawn(PROGRAM, ["--no-browser"], {
    env: { ...process.env, PORT: String(port), TRAINSLATOR_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, () => child.exitCode);
    const page = await get(url, "text/html");
    const script = page.match(/src="\/(assets\/[^"]+\.js)"/)?.[1];
    if (!script) throw new Error("the page doesn't load a script");
    await get(`${url}/${script}`, "text/javascript");
  } catch (error) {
    throw new Error(`The smoke test failed: ${(error as Error).message}\n${output}`);
  } finally {
    child.kill();
    await exited;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function waitForHealth(url: string, exitCode: () => number | null): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const code = exitCode();
    if (code !== null) throw new Error(`the program exited with code ${code}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error("the server didn't answer within 30 seconds");
}

async function get(url: string, type: string): Promise<string> {
  const res = await fetch(url);
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.startsWith(type))
    throw new Error(`${url} answered ${res.status} ${contentType}`);
  return res.text();
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as net.AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}
