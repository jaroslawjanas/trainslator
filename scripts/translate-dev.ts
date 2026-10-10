/**
 * Translate a whole EPUB from the command line (phase 3 only, no knowledge bases).
 *
 *   pnpm translate:dev book.epub --target pl --base-url https://api.openai.com/v1 \
 *     --model gpt-x --key-env OPENAI_API_KEY [--kind openai] [--parallel 4] \
 *     [--reasoning low] [--chunk-tokens 1500] [--context 128000] [--max-output 16000] \
 *     [--chapters 2] [--data data/dev] [--stream]
 *
 * Work is saved in the data folder, so running the same command again resumes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { EpubBook } from "../src/epub/book.ts";
import { buildSegments } from "../src/epub/segments.ts";
import type { CallTarget } from "../src/llm/call.ts";
import { KIND_PRESETS } from "../src/llm/presets.ts";
import { createLlmRuntime } from "../src/llm/runtime.ts";
import { buildBook } from "../src/pipeline/build.ts";
import { preparePhase3, runPhase3, translateToc } from "../src/pipeline/phase3.ts";
import { directionOf, languageDisplayName, scriptOf } from "../src/shared/languages.ts";
import {
  type Connection,
  ConnectionKind,
  defaultSettings,
  defaultStepSettings,
  type Model,
  type Settings,
} from "../src/shared/schemas/settings.ts";
import { DataPaths } from "../src/store/paths.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    "key-env": { type: "string" },
    kind: { type: "string", default: "custom" },
    parallel: { type: "string", default: "4" },
    reasoning: { type: "string" },
    "chunk-tokens": { type: "string" },
    context: { type: "string", default: "128000" },
    "max-output": { type: "string", default: "16000" },
    chapters: { type: "string" },
    data: { type: "string", default: path.join("data", "dev") },
    stream: { type: "boolean", default: false },
    "use-best": { type: "boolean", default: true },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const input = positionals[0];
if (!input || !values.target || !values["base-url"] || !values.model) {
  fail(
    "Usage: pnpm translate:dev <book.epub> --target <lang> --base-url <url> --model <name> [--key-env VAR] [--kind openai|openrouter|…]",
  );
}
const kind = ConnectionKind.parse(values.kind);
const connection: Connection = {
  id: "dev",
  name: "dev",
  kind,
  baseUrl: values["base-url"],
  apiKey: values["key-env"] ? { kind: "env", name: values["key-env"] } : { kind: "none" },
  headers: [],
  maxParallel: null,
  timeoutSec: 1800,
  idleTimeoutSec: 600,
  maxRetries: 4,
  stream: values.stream,
};
const model: Model = {
  id: "dev-model",
  connectionId: "dev",
  modelName: values.model,
  label: values.model,
  contextWindow: Number(values.context),
  maxOutputTokens: Number(values["max-output"]),
  maxParallel: Number(values.parallel),
  pricing: null,
  ...KIND_PRESETS[kind].model,
};
const step = {
  ...defaultStepSettings(),
  modelId: model.id,
  reasoning: {
    enabled: Boolean(values.reasoning),
    effort: values.reasoning ?? null,
    budgetTokens: null,
  },
};
const settings: Settings = { ...defaultSettings(), connections: [connection], models: [model] };

const bytes = new Uint8Array(await fs.readFile(input));
const book = EpubBook.open(bytes);
const baseName = path.basename(input, path.extname(input));
const paths = new DataPaths(values.data);
const projectId = "dev";
const bookId = baseName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "book";
const rt = await createLlmRuntime(paths, { settings: () => settings });
const target: CallTarget = { connection, model, step };
const targetLang = values.target;
const segments = buildSegments(book, "en").segmentsByDepth["1"] ?? [];
const chosen = values.chapters
  ? segments.filter((s) => s.guess === "body").slice(0, Number(values.chapters))
  : segments;
const chosenDocs = new Set(chosen.flatMap((s) => s.ranges.map((r) => r.docIndex)));
const keepDocs = values.chapters
  ? new Set(book.docs.filter((d) => !chosenDocs.has(d.index) && !d.isNav).map((d) => d.index))
  : new Set<number>();

const env = {
  rt,
  paths,
  projectId,
  bookId,
  target,
  tocTarget: target,
  book,
  languages: {
    sourceLang: "en",
    sourceName: "English",
    targetLang,
    targetName: languageDisplayName(targetLang),
    targetScript: scriptOf(targetLang),
  },
  languageNotes: "",
  referenceKb: null,
  bookKb: null,
  synopses: new Map<string, string>(),
  segments: chosen,
  keepDocs,
  chunkTokens: values["chunk-tokens"] ? Number(values["chunk-tokens"]) : undefined,
  onProgress: (done: number, total: number, label: string) =>
    console.log(`[${done}/${total}] ${label}`),
  log: (m: string) => console.log(`  ${m}`),
};

console.log(
  `Translating "${book.title}" into ${env.languages.targetName} with ${model.modelName}…`,
);
const prepared = await preparePhase3(env);
console.log(
  `${prepared.plan.chunks.length} chunks in ${prepared.plan.chapters.length} chapters (≈${prepared.plan.chunkTokens} source tokens each).`,
);
const summary = await runPhase3(env, prepared);
console.log(
  `Translated: ${summary.ok} ok, ${summary.flagged} flagged, ${summary.refused} refused.`,
);
await translateToc(env, prepared);
const { file, report } = await buildBook({
  paths,
  projectId,
  bookId,
  book,
  sourceLang: "en",
  targetLang,
  direction: directionOf(targetLang),
  keepDocs,
  baseName,
  options: { useBestAttempts: values["use-best"], newIdentifier: true, removeEmbeddedFonts: false },
});
await rt.calibration.flush();
console.log(`Wrote ${file}`);
console.log(
  `Usage: ${summary.usage.calls} calls, ${summary.usage.promptTokens} prompt tokens (${summary.usage.cachedTokens} cached), ${summary.usage.completionTokens} output tokens${summary.usage.cost !== null ? `, $${summary.usage.cost.toFixed(4)}` : ""}.`,
);
if (report.newXmlProblems.length > 0)
  console.log("New XML problems:", JSON.stringify(report.newXmlProblems, null, 2));
if (report.missingGlyphs.length > 0)
  console.log(`Characters the embedded fonts may lack: ${report.missingGlyphs.join(" ")}`);
