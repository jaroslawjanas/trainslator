import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connection } from "../shared/schemas/settings.ts";
import { LlmError } from "./errors.ts";
import type { RawResult } from "./response.ts";
import type { Watch } from "./watch.ts";

/**
 * Claude Code as a provider: each request runs `claude -p` on this computer
 * with the Claude subscription it's logged in to. The stable part of the
 * prompt goes in a system-prompt file (Claude Code caches it), the rest
 * through stdin, which has no length limit. It runs without tools and
 * without the user's Claude Code setup (--safe-mode), and saves no session.
 */

type Dict = Record<string, unknown>;

function obj(value: unknown): Dict {
  return value && typeof value === "object" ? (value as Dict) : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Model names offered in the settings: the aliases, then full names. */
export const CLAUDE_CODE_MODELS = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
];

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Claude Code's --effort takes low to max; "none" and "minimal" become low. */
function effortFlag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const effort = value.trim().toLowerCase();
  if (effort === "none" || effort === "minimal") return "low";
  return EFFORTS.has(effort) ? effort : null;
}

/** The command-line arguments for a request body built by request.ts. */
export function claudeCodeArgs(body: Dict, systemFile: string): string[] {
  const args = ["-p", "--output-format", body.stream ? "stream-json" : "json"];
  if (body.stream) args.push("--verbose", "--include-partial-messages");
  args.push(
    "--system-prompt-file",
    systemFile,
    "--tools",
    "",
    "--safe-mode",
    "--no-session-persistence",
    "--disable-slash-commands",
  );
  if (typeof body.model === "string" && body.model) args.push("--model", body.model);
  const effort = effortFlag(body.effort);
  if (effort) args.push("--effort", effort);
  if (body.json_schema) args.push("--json-schema", JSON.stringify(body.json_schema));
  // Extra arguments from a step's "extra request parameters", e.g. {"args": ["--fallback-model", "sonnet"]}.
  if (Array.isArray(body.args))
    args.push(...body.args.filter((a): a is string => typeof a === "string"));
  return args;
}

/**
 * Variables a Claude Code session sets for programs it starts; a request
 * must not look like part of that session. API keys are left out so the
 * request always uses the subscription.
 */
const DROPPED_ENV =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|EXECPATH)|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/i;

function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED_ENV.test(key)));
}

/** An empty folder to run in, so no project's files or settings are picked up. */
async function workDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "trainslator-claude-code");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

type Spawn = typeof spawn;
let spawnProcess: Spawn = spawn;

/** Tests run a fake Claude Code instead. */
export function useClaudeCodeSpawn(fn: Spawn | null): void {
  spawnProcess = fn ?? spawn;
}

function formatReset(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** An error result as an LlmError the rest of the app knows how to handle. */
function resultError(result: Dict, rateLimit: Dict | null): LlmError {
  const errors = Array.isArray(result.errors) ? result.errors.map(String).join("; ") : "";
  const text = String(
    (typeof result.result === "string" && result.result) || errors || result.subtype || "error",
  );
  const status = typeof result.api_error_status === "number" ? result.api_error_status : null;
  if (status === 401 || status === 403 || /\/login|not logged in|log ?in again|oauth/i.test(text))
    return new LlmError(
      "auth",
      `Claude Code isn't logged in to a Claude subscription. Run claude in a terminal and log in with /login. (${text})`,
      { status },
    );
  const limited =
    status === 429 || rateLimit?.status === "rejected" || /usage limit|rate limit/i.test(text);
  if (limited) {
    const resets = typeof rateLimit?.resetsAt === "number" ? rateLimit.resetsAt : null;
    // A used-up subscription window won't come back within minutes: stop the job.
    if (resets && resets * 1000 - Date.now() > 5 * 60_000)
      return new LlmError(
        "config",
        `Your Claude subscription's usage limit is reached; it resets ${formatReset(resets)}. Resume the job then.`,
        { status },
      );
    return new LlmError("rate_limit", `Claude Code: ${text}`, { status: status ?? 429 });
  }
  if (status === 400) return new LlmError("bad_request", `Claude Code: ${text}`, { status });
  return new LlmError("transport", `Claude Code: ${text}`, { status });
}

/** The final "result" message as a RawResult. */
export function fromClaudeCodeResult(
  result: Dict,
  extra: { reasoning?: string; rateLimit?: Dict | null } = {},
): RawResult {
  if (
    result.is_error === true ||
    (typeof result.subtype === "string" && result.subtype !== "success")
  )
    throw resultError(result, extra.rateLimit ?? null);
  const structured = result.structured_output;
  const content =
    structured !== undefined && structured !== null
      ? JSON.stringify(structured)
      : typeof result.result === "string"
        ? result.result
        : "";
  const usage = obj(result.usage);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const stop = result.stop_reason;
  return {
    content,
    reasoning: extra.reasoning ?? "",
    refusal: stop === "refusal" ? "Claude declined to answer." : null,
    finishReason: stop === "max_tokens" ? "length" : stop === "refusal" ? "content_filter" : "stop",
    usage: {
      // input_tokens counts only the uncached part of the prompt.
      promptTokens: num(usage.input_tokens) + cacheRead + cacheWrite,
      completionTokens: num(usage.output_tokens),
      reasoningTokens: num(obj(usage.output_tokens_details).thinking_tokens),
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      // The subscription pays; Claude Code's total_cost_usd is only what the API would charge.
      cost: 0,
    },
    model: Object.keys(obj(result.modelUsage))[0] ?? null,
  };
}

/** Reads `--output-format stream-json` line by line. */
class StreamReader {
  reasoning = "";
  result: Dict | null = null;
  rateLimit: Dict | null = null;
  private readonly onText?: (chars: number) => void;

  constructor(onText?: (chars: number) => void) {
    this.onText = onText;
  }

  line(text: string): void {
    if (!text.trim()) return;
    let message: Dict;
    try {
      message = JSON.parse(text) as Dict;
    } catch {
      return;
    }
    if (message.type === "result") this.result = message;
    else if (message.type === "rate_limit_event") this.rateLimit = obj(message.rate_limit_info);
    else if (message.type === "stream_event") {
      const event = obj(message.event);
      if (event.type !== "content_block_delta") return;
      const delta = obj(event.delta);
      const piece =
        delta.type === "text_delta"
          ? delta.text
          : delta.type === "thinking_delta"
            ? delta.thinking
            : delta.type === "input_json_delta"
              ? delta.partial_json
              : "";
      if (typeof piece !== "string" || !piece) return;
      if (delta.type === "thinking_delta") this.reasoning += piece;
      this.onText?.(piece.length);
    }
  }
}

function notStarted(command: string, error: unknown): LlmError {
  return new LlmError(
    "config",
    `Couldn't start Claude Code ("${command}"): ${(error as Error).message}. Install it, or set the connection's command to the full path of claude.`,
    { cause: error },
  );
}

/** Runs one request. The body comes from request.ts (system, prompt, model, effort, schema). */
export async function sendClaudeCode(
  connection: Connection,
  body: Dict,
  watch: Watch,
  onText?: (chars: number) => void,
): Promise<RawResult> {
  const dir = await workDir();
  const systemFile = path.join(dir, `system-${randomUUID()}.txt`);
  await fs.writeFile(systemFile, String(body.system ?? ""), "utf8");
  try {
    return await run(
      connection.baseUrl.trim(),
      claudeCodeArgs(body, systemFile),
      String(body.prompt ?? ""),
      Boolean(body.stream),
      dir,
      watch,
      onText,
    );
  } finally {
    await fs.rm(systemFile, { force: true });
  }
}

function run(
  command: string,
  args: string[],
  input: string,
  stream: boolean,
  cwd: string,
  watch: Watch,
  onText?: (chars: number) => void,
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, args, {
        cwd,
        env: childEnv(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(notStarted(command, error));
      return;
    }
    const stop = () => child.kill();
    watch.signal.addEventListener("abort", stop, { once: true });
    watch.activity();
    const reader = new StreamReader(onText);
    let stdout = "";
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      watch.signal.removeEventListener("abort", stop);
      fn();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      watch.activity();
      if (!stream) {
        stdout += chunk;
        return;
      }
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        reader.line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? notStarted(command, error)
            : new LlmError("transport", `Claude Code failed: ${error.message}`, { cause: error }),
        ),
      ),
    );
    child.on("close", (code) =>
      finish(() => {
        if (watch.signal.aborted) {
          reject(new Error("Claude Code was stopped."));
          return;
        }
        try {
          let result: Dict | null;
          if (stream) {
            reader.line(buffer);
            result = reader.result;
          } else {
            const text = stdout.trim();
            result = text ? (JSON.parse(text.slice(text.lastIndexOf("\n{") + 1)) as Dict) : null;
          }
          if (!result) {
            const detail = stderr.trim() || stdout.trim().slice(-500) || "no output";
            reject(
              /\/login|not logged in/i.test(detail)
                ? new LlmError(
                    "auth",
                    `Claude Code isn't logged in. Run claude in a terminal and log in with /login. (${detail})`,
                  )
                : new LlmError(
                    "transport",
                    `Claude Code ended without an answer (exit code ${code}): ${detail}`,
                  ),
            );
            return;
          }
          resolve(
            fromClaudeCodeResult(result, {
              reasoning: reader.reasoning,
              rateLimit: reader.rateLimit,
            }),
          );
        } catch (error) {
          reject(
            error instanceof LlmError
              ? error
              : new LlmError(
                  "transport",
                  `Claude Code's output couldn't be read: ${stderr.trim()}`,
                  {
                    cause: error,
                  },
                ),
          );
        }
      }),
    );
    // The program may exit before reading everything (e.g. not logged in).
    child.stdin?.on("error", () => {});
    child.stdin?.end(input, "utf8");
  });
}
