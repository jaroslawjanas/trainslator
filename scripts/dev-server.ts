/**
 * Runs the API server for `pnpm dev` and restarts it when its code changes.
 *
 * Not `node --watch`: on Windows that also restarts when a source file is
 * merely read (by an editor, git, Vite or a type check), because reading
 * can update the file's last-access time, and a restart interrupts every
 * running job. This restarts only when a file's modification time or size
 * changes.
 *
 *   node scripts/dev-server.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import path from "node:path";

const SERVER_ARGS = ["--env-file-if-exists=.env", "src/server/main.ts", "--dev"];
const WATCHED_DIR = "src";
const ENV_FILE = ".env";

/** Modification time and size; a read leaves both alone. */
function signature(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

function isServerCode(file: string): boolean {
  return file.endsWith(".ts") && !file.endsWith(".test.ts");
}

const known = new Map<string, string>();
for (const name of readdirSync(WATCHED_DIR, { recursive: true }) as string[]) {
  const file = path.join(WATCHED_DIR, name);
  if (isServerCode(file)) known.set(file, signature(file));
}
known.set(ENV_FILE, signature(ENV_FILE));

let child: ChildProcess | null = null;
let stopping: Promise<void> | null = null;

function start(): void {
  const proc = spawn(process.execPath, SERVER_ARGS, { stdio: "inherit" });
  child = proc;
  proc.on("exit", (code, signal) => {
    if (child !== proc) return;
    child = null;
    if (!stopping)
      console.log(
        `The server stopped (${signal ?? `exit code ${code}`}). Waiting for file changes before restarting...`,
      );
  });
}

async function stop(): Promise<void> {
  const proc = child;
  if (!proc) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill();
  await exited;
}

let pending: string | null = null;
let timer: NodeJS.Timeout | null = null;

function changed(file: string): void {
  const now = signature(file);
  if (known.get(file) === now) return;
  known.set(file, now);
  pending = file;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    console.log(`Restarting the server: ${pending} changed.`);
    stopping = stop().then(() => {
      stopping = null;
      start();
    });
  }, 300);
}

watch(WATCHED_DIR, { recursive: true }, (_event, name) => {
  if (!name) return;
  const file = path.join(WATCHED_DIR, name.toString());
  if (isServerCode(file)) changed(file);
});
watch(".", (_event, name) => {
  if (name?.toString() === ENV_FILE) changed(ENV_FILE);
});

const shutdown = () => {
  stopping = stop().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
