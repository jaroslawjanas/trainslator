import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import sea from "node:sea";
import type { WebFiles } from "./app.ts";

/**
 * The standalone app: one program with Node, the server and the built web UI
 * in it, made by `pnpm package` (Node's single executable applications). It
 * keeps its data next to the program and opens the browser itself.
 */

export const standalone = sea.isSea();

/** The web UI embedded in the program, as assets named web/<path>. */
export function embeddedWeb(): WebFiles {
  const keys = new Set(sea.getAssetKeys());
  return async (file) => {
    const key = `web/${file}`;
    return keys.has(key) ? new Uint8Array(sea.getAsset(key)) : null;
  };
}

/** Opens a page in the default browser. Callers print the address too, in case this fails. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => console.log(`Couldn't open a browser. Open ${url} yourself.`));
  child.unref();
}

/** Keeps a double-clicked program's window open until Enter, so its message can be read. */
export async function waitForEnter(): Promise<void> {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter to close.");
  rl.close();
}
