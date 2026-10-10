/**
 * Live smoke test against a real OpenAI-compatible endpoint. Runs every step
 * of the app on a tiny invented book (a few hundred words), through the same
 * API the browser uses, in a temporary data folder:
 *
 *   connection test → language notes → reference pair + phase 1 →
 *   book + phase 2 → phase 3 → build → reopen the output
 *
 *   pnpm test:live --base-url https://ollama.com/v1 --model deepseek-v4.1-flash:cloud \
 *     --kind ollama --key-env OLLAMA_API_KEY [--target pl] [--context 128000] \
 *     [--max-output 16000] [--parallel 4] [--keep]
 *
 * The same settings can come from the environment: LIVE_BASE_URL, LIVE_MODEL,
 * LIVE_KIND, LIVE_KEY_ENV, LIVE_TARGET. It sends about 15 small requests.
 * Exits with 1 when a step fails.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { EpubBook } from "../src/epub/book.ts";
import { KIND_PRESETS } from "../src/llm/presets.ts";
import { createApp } from "../src/server/app.ts";
import { createContext } from "../src/server/context.ts";
import { jobHandlers } from "../src/server/handlers.ts";
import type { Alignment } from "../src/shared/schemas/alignment.ts";
import type { Job } from "../src/shared/schemas/jobs.ts";
import type { Kb } from "../src/shared/schemas/kb.ts";
import { type Connection, ConnectionKind, type Model } from "../src/shared/schemas/settings.ts";
import { sampleNovel, sampleNovelTranslation } from "../src/testing/epub-fixtures.ts";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: process.env.LIVE_BASE_URL },
    model: { type: "string", default: process.env.LIVE_MODEL },
    kind: { type: "string", default: process.env.LIVE_KIND ?? "custom" },
    "key-env": { type: "string", default: process.env.LIVE_KEY_ENV },
    target: { type: "string", default: process.env.LIVE_TARGET ?? "pl" },
    context: { type: "string", default: "128000" },
    "max-output": { type: "string", default: "16000" },
    parallel: { type: "string", default: "4" },
    keep: { type: "boolean", default: false },
  },
});

if (!values["base-url"] || !values.model) {
  console.error(
    "Usage: pnpm test:live --base-url <url> --model <name> [--kind openai|openrouter|ollama|…] [--key-env VAR] [--target pl]",
  );
  process.exit(1);
}
const kind = ConnectionKind.parse(values.kind);
const keyEnv = values["key-env"] ?? KIND_PRESETS[kind].suggestedKeyEnv;
if (keyEnv && !process.env[keyEnv]) {
  console.error(`The environment variable ${keyEnv} is empty. Put the key in .env.`);
  process.exit(1);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trainslator-live-"));
const ctx = await createContext({ dataDir: dir, port: 5174, handlers: jobHandlers });
const app = createApp(ctx);

async function api<T = Record<string, unknown>>(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { host: "127.0.0.1:5174" };
  let payload: string | FormData | undefined;
  if (method !== "GET") headers.origin = "http://127.0.0.1:5174";
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await app.request(url, { method, headers, body: payload });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`${method} ${url}: ${res.status} ${data.error?.message ?? ""}`);
  }
  return (
    res.headers.get("content-type")?.includes("json")
      ? await res.json()
      : new Uint8Array(await res.arrayBuffer())
  ) as T;
}

let failures = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const started = Date.now();
  process.stdout.write(`• ${name} … `);
  try {
    const result = await fn();
    console.log(`ok (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return result;
  } catch (error) {
    failures++;
    console.log(`FAILED\n    ${(error as Error).message}`);
    return null;
  }
}

async function runJob(url: string, body?: unknown): Promise<Job> {
  const { job } = await api<{ job: Job }>("POST", url, body);
  const done = await ctx.runner.wait(job.id);
  if (!done) throw new Error("the job disappeared");
  if (done.status === "done_with_errors")
    console.log(`\n    finished with ${done.itemErrors} item error(s); see the job log`);
  else if (done.status !== "done")
    throw new Error(`job ended as ${done.status}${done.error ? `: ${done.error}` : ""}`);
  return done;
}

const connection: Connection = {
  id: "live",
  name: "Live test",
  kind,
  baseUrl: values["base-url"],
  apiKey: keyEnv ? { kind: "env", name: keyEnv } : { kind: "none" },
  headers: [],
  maxParallel: Number(values.parallel),
  timeoutSec: 600,
  idleTimeoutSec: 300,
  maxRetries: 3,
  stream: true,
};
const model: Model = {
  id: "live_model",
  connectionId: connection.id,
  modelName: values.model,
  label: values.model,
  contextWindow: Number(values.context),
  maxOutputTokens: Number(values["max-output"]),
  pricing: null,
  ...KIND_PRESETS[kind].model,
};

console.log(`Live smoke test: ${model.modelName} at ${connection.baseUrl} → ${values.target}`);
console.log(`Data folder: ${dir}\n`);

await step("settings", async () => {
  await api("PUT", `/api/settings/connections/${connection.id}`, connection);
  await api("PUT", `/api/settings/models/${model.id}`, model);
  const steps = ctx.settings.get().steps;
  await api(
    "PUT",
    "/api/settings/steps",
    Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ...v, modelId: model.id }])),
  );
});

await step("connection test", async () => {
  const { report } = await api<{
    report: { checks: { name: string; ok: boolean | null; detail: string }[] };
  }>("POST", `/api/settings/connections/${connection.id}/test`, { modelId: model.id });
  for (const c of report.checks)
    console.log(`\n    ${c.ok === null ? "–" : c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  if (!report.checks.some((c) => c.ok)) throw new Error("no check passed");
});

const project = await step("project and language notes", async () => {
  const { project } = await api<{ project: { id: string } }>("POST", "/api/projects", {
    name: "Live smoke test",
    targetLang: values.target,
  });
  await runJob(`/api/projects/${project.id}/language-notes/generate`);
  return project;
});
if (!project) process.exit(1);
const pid = project.id;

await step("reference pair and phase 1", async () => {
  const form = new FormData();
  form.set("source", new File([sampleNovel()], "novel.epub"));
  form.set("target", new File([sampleNovelTranslation()], "novel-translated.epub"));
  const { pair } = await api<{ pair: { id: string } }>("POST", `/api/projects/${pid}/pairs`, form);
  const { alignment } = await api<{ alignment: Alignment }>(
    "GET",
    `/api/projects/${pid}/pairs/${pair.id}`,
  );
  await api("PUT", `/api/projects/${pid}/pairs/${pair.id}/alignment`, {
    ...alignment,
    status: "confirmed",
    units: alignment.units.map((u) => ({
      ...u,
      include: u.source.length > 0 && u.target.length > 0,
    })),
  });
  await runJob(`/api/projects/${pid}/pairs/${pair.id}/phase1/run`);
  const { kb } = await api<{ kb: Kb }>("GET", `/api/projects/${pid}/pairs/${pair.id}/kb`);
  console.log(`\n    ${kb.entries.length} entries, ${kb.styleRules.length} style rules`);
  return pair.id;
});

const bookId = await step("book and phase 2", async () => {
  const form = new FormData();
  form.set("file", new File([sampleNovel()], "novel.epub"));
  const { book } = await api<{ book: { id: string } }>("POST", `/api/projects/${pid}/books`, form);
  await runJob(`/api/projects/${pid}/books/${book.id}/phase2/run`);
  const { kb } = await api<{ kb: Kb }>("GET", `/api/projects/${pid}/books/${book.id}/kb`);
  const open = kb.entries.filter((e) => e.status === "open").length;
  console.log(`\n    ${kb.entries.length} entries (${open} open questions)`);
  return book.id;
});

if (bookId) {
  await step("phase 3", async () => {
    // Flagged units end the job as done_with_errors; the build then uses best attempts.
    await runJob(`/api/projects/${pid}/books/${bookId}/phase3/run`);
    const { totals } = await api<{ totals: Record<string, number> | null }>(
      "GET",
      `/api/projects/${pid}/books/${bookId}/chapters`,
    );
    console.log(`\n    ${JSON.stringify(totals)}`);
  });

  await step("build and reopen", async () => {
    await runJob(`/api/projects/${pid}/books/${bookId}/build`, { useBestAttempts: true });
    const { report } = await api<{
      report: { newXmlProblems: unknown[]; fileName: string };
    }>("GET", `/api/projects/${pid}/books/${bookId}/build/report`);
    const bytes = await api<Uint8Array>("GET", `/api/projects/${pid}/books/${bookId}/output`);
    const out = EpubBook.open(bytes);
    console.log(
      `\n    ${report.fileName}: "${out.title}", language ${out.pkg.languages.join(", ")}`,
    );
    if (report.newXmlProblems.length > 0)
      throw new Error(`${report.newXmlProblems.length} new XML problems`);
  });
}

// Usage per step, from the call log: shows whether the provider reports cached tokens.
const calls = await ctx.rt.log.read(pid);
const byStep = new Map<string, { calls: number; prompt: number; cached: number; out: number }>();
for (const c of calls) {
  const s = byStep.get(c.step) ?? { calls: 0, prompt: 0, cached: 0, out: 0 };
  s.calls++;
  s.prompt += c.usage.promptTokens;
  s.cached += c.usage.cachedTokens;
  s.out += c.usage.completionTokens;
  byStep.set(c.step, s);
}
console.log("\nUsage by step:");
for (const [name, s] of byStep)
  console.log(
    `  ${name.padEnd(18)} ${String(s.calls).padStart(3)} calls  ${String(s.prompt).padStart(7)} in (${s.cached} cached)  ${String(s.out).padStart(6)} out`,
  );
const cached = [...byStep.values()].reduce((sum, s) => sum + s.cached, 0);
console.log(
  cached > 0
    ? "Prompt caching: the provider reports cached tokens."
    : "Prompt caching: no cached tokens reported (the provider may not cache or not report it).",
);

await ctx.rt.calibration.flush();
if (!values.keep) await fs.rm(dir, { recursive: true, force: true });
else console.log(`Kept the data folder: ${dir}`);
console.log(failures === 0 ? "\nAll steps passed." : `\n${failures} step(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
