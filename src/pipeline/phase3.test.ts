import { afterEach, describe, expect, it } from "vitest";
import { EpubBook } from "../epub/book.ts";
import { buildSegments } from "../epub/segments.ts";
import { readZip } from "../epub/zip.ts";
import { ChunkResult, Glossary, ManualEdits } from "../shared/schemas/translation.ts";
import { readJson, writeJson } from "../store/json.ts";
import { sampleNovel } from "../testing/epub-fixtures.ts";
import { type FakeHandler, type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
import { isTocRequest, requestedUnits, shout, translateReply } from "../testing/fake-translator.ts";
import {
  makeConnection,
  makeModel,
  makeRuntime,
  makeStep,
  type TestRuntime,
} from "../testing/llm-fixtures.ts";
import { BuildBlockedError, buildBook } from "./build.ts";
import { type Phase3Env, preparePhase3, runPhase3, translateToc } from "./phase3.ts";

let server: FakeServer | null = null;
let env: TestRuntime | null = null;
afterEach(async () => {
  await server?.close();
  await env?.cleanup();
  server = null;
  env = null;
});

async function setup(handler: FakeHandler, chunkTokens = 120): Promise<Phase3Env> {
  server = await startFakeOpenAI(handler);
  const connection = makeConnection(server.url);
  const model = makeModel("openai");
  env = await makeRuntime(connection, model);
  const book = EpubBook.open(sampleNovel());
  return {
    rt: env.rt,
    paths: env.paths,
    projectId: "pr_test",
    bookId: "bk_test",
    target: { connection, model, step: makeStep() },
    tocTarget: { connection, model, step: makeStep() },
    book,
    languages: {
      sourceLang: "en",
      sourceName: "English",
      targetLang: "pl",
      targetName: "Polish",
      targetScript: "Latn",
    },
    languageNotes: "",
    referenceKb: null,
    bookKb: null,
    synopses: new Map(),
    segments: buildSegments(book, "en").segmentsByDepth["1"]!,
    keepDocs: new Set(),
    chunkTokens,
  };
}

async function translatedFile(e: Phase3Env, name: string, useBest = false): Promise<string> {
  const { file } = await buildBook({
    paths: e.paths,
    projectId: e.projectId,
    bookId: e.bookId,
    book: e.book,
    sourceLang: "en",
    targetLang: "pl",
    direction: "ltr",
    keepDocs: e.keepDocs,
    baseName: "novel",
    options: { useBestAttempts: useBest, newIdentifier: false, removeEmbeddedFonts: false },
  });
  const { promises: fs } = await import("node:fs");
  const bytes = new Uint8Array(await fs.readFile(file));
  return new TextDecoder().decode(readZip(bytes).find((x) => x.name === name)!.data);
}

describe("phase 3", () => {
  it("translates a whole book into a valid EPUB", async () => {
    const e = await setup((body) => translateReply(body));
    const prepared = await preparePhase3(e);
    expect(prepared.plan.chunks.length).toBeGreaterThan(2);
    const summary = await runPhase3(e, prepared);
    expect(summary).toMatchObject({ flagged: 0, refused: 0 });
    await translateToc(e, prepared);
    const ch1 = await translatedFile(e, "OEBPS/text/ch1.xhtml");
    expect(ch1).toContain('<span class="dropcap">M</span>IRA CLIMBED');
    expect(ch1).toContain("<i>GRAY HERON</i>");
    const nav = await translatedFile(e, "OEBPS/nav.xhtml");
    expect(nav).toContain(">CHAPTER ONE</a>");
  });

  it("resumes without repeating finished chunks", async () => {
    const e = await setup((body) => translateReply(body));
    const prepared = await preparePhase3(e);
    await runPhase3(e, prepared);
    const sent = server!.requests.length;
    const again = await runPhase3(e, await preparePhase3(e));
    expect(again.translatedChunks).toBe(0);
    expect(server!.requests.length).toBe(sent);
  });

  it("repairs a broken placeholder with a repair turn", async () => {
    let broke = false;
    const e = await setup((body) => {
      const isRepair = (body.messages as unknown[]).length > 2;
      return translateReply(body, (_id, text) => {
        if (!broke && !isRepair && text.includes("<x4/>")) {
          broke = true;
          return shout(text).replace("<x4/>", "");
        }
        return shout(text);
      });
    });
    const summary = await runPhase3(e);
    expect(summary.flagged).toBe(0);
    expect(broke).toBe(true);
  });

  it("keeps good units, retries a bad one alone, then flags it", async () => {
    const e = await setup((body) =>
      translateReply(body, (_id, text) =>
        text.startsWith("The keeper") ? "<g9>BROKEN</g9>" : shout(text),
      ),
    );
    const summary = await runPhase3(e);
    expect(summary.flagged).toBe(1);
    expect(summary.ok).toBeGreaterThan(10);
    await translateToc(e, await preparePhase3(e));
    await expect(translatedFile(e, "OEBPS/text/ch1.xhtml")).rejects.toBeInstanceOf(
      BuildBlockedError,
    );
    const ch1 = await translatedFile(e, "OEBPS/text/ch1.xhtml", true);
    // The best attempt is made safe by dropping the invented placeholder.
    expect(ch1).toContain("<p>BROKEN</p>");
    expect(ch1).toContain('<span class="dropcap">M</span>IRA CLIMBED');
  });

  it("marks refused chunks and carries on", async () => {
    const e = await setup((body) =>
      JSON.stringify(body.messages).includes("storm came") && !isTocRequest(body)
        ? { content: "", refusal: "No." }
        : translateReply(body),
    );
    const summary = await runPhase3(e);
    expect(summary.refused).toBeGreaterThan(0);
    expect(summary.ok).toBeGreaterThan(0);
  });

  it("splits a chunk whose answer was cut off", async () => {
    const e = await setup((body) => {
      const units = requestedUnits(body);
      if (!isTocRequest(body) && units.length > 1)
        return { content: '{"units": [', finishReason: "length" };
      return translateReply(body);
    }, 400);
    const summary = await runPhase3(e);
    expect(summary.flagged).toBe(0);
    expect(server!.requests.some((r) => requestedUnits(r).length === 1)).toBe(true);
  });

  it("collects coined terms in a glossary and sends it with later chunks", async () => {
    const e = await setup((body) => {
      const reply = translateReply(body);
      const parsed = JSON.parse(reply.content!);
      if (!isTocRequest(body))
        parsed.coined = [{ kind: "person", source: "Mira", target: "Mira", note: "kept" }];
      return { content: JSON.stringify(parsed) };
    });
    await runPhase3(e);
    const glossary = await readJson(e.paths.phase3Glossary(e.projectId, e.bookId), Glossary);
    expect(glossary?.terms.map((t) => t.source)).toEqual(["Mira"]);
    expect(JSON.stringify(server!.requests.at(-1)!.messages)).toContain("Terms introduced earlier");
  });

  it("uses manual edits when building", async () => {
    const e = await setup((body) => translateReply(body));
    const prepared = await preparePhase3(e);
    await runPhase3(e, prepared);
    await translateToc(e, prepared);
    const results = await readJson(e.paths.phase3Result(e.projectId, e.bookId, 0), ChunkResult);
    const key = results!.units[0]!.key;
    await writeJson(e.paths.phase3Edits(e.projectId, e.bookId), ManualEdits, {
      schemaVersion: 1,
      edits: {
        [key]: { text: "Ręcznie poprawione", at: new Date().toISOString(), previous: null },
      },
    });
    const doc = prepared.units.get(key)!.file;
    expect(await translatedFile(e, doc)).toContain("Ręcznie poprawione");
  });
});
