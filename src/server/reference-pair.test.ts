import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Glossary } from "../shared/schemas/translation.ts";
import { writeJson } from "../store/json.ts";
import { sampleNovel } from "../testing/epub-fixtures.ts";
import { type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
import { translateReply } from "../testing/fake-translator.ts";
import { makeConnection, makeModel } from "../testing/llm-fixtures.ts";
import { makeTestServer, type TestServer } from "../testing/server.ts";

let srv: TestServer | null = null;
let fake: FakeServer | null = null;
afterEach(async () => {
  await fake?.close();
  await srv?.cleanup();
  srv = null;
  fake = null;
});

interface PairDetail {
  pair: {
    id: string;
    title: string;
    targetFileName: string;
    phase1: { state: string; entries: number | null };
    fromBook: { bookId: string; title: string } | null;
  };
  source: { segmentsByDepth: Record<string, { id: string }[]> };
  alignment: {
    status: string;
    tocDepthSource: number;
    units: { source: string[]; target: string[] }[];
  };
}

interface Preview {
  build: { fileName: string } | null;
  buildCurrent: boolean | null;
  kb: { entries: number; open: number; yours: number };
  coined: { left: number; conflicts: number };
}

const newEntry = (source: string, target: string) => ({
  kind: "person",
  source,
  aliases: [],
  target,
  targetSeen: [],
  treatment: "translated",
  attributes: [],
  note: "",
  examples: [],
  status: "locked",
  question: null,
});

async function setup() {
  fake = await startFakeOpenAI((body) => translateReply(body));
  srv = await makeTestServer();
  await srv.json("PUT", "/api/settings/connections/conn1", makeConnection(fake.url));
  await srv.json("PUT", "/api/settings/models/model1", makeModel("openai"));
  const steps = srv.ctx.settings.get().steps;
  await srv.json(
    "PUT",
    "/api/settings/steps",
    Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ...v, modelId: "model1" }])),
  );
  const { project } = await srv.json<{ project: { id: string } }>("POST", "/api/projects", {
    name: "P",
    targetLang: "pl",
  });
  const form = new FormData();
  form.set("file", new File([sampleNovel()], "novel.epub"));
  const { book } = await srv.json<{ book: { id: string } }>(
    "POST",
    `/api/projects/${project.id}/books`,
    form,
  );
  return { pid: project.id, bookId: book.id };
}

async function runJob(url: string, body?: unknown) {
  const { job } = await srv!.json<{ job: { id: string } }>("POST", url, body);
  const done = await srv!.ctx.runner.wait(job.id);
  expect(done?.error ?? null).toBeNull();
  return done!;
}

describe("a finished book as a reference pair", () => {
  it("makes a pair from the original, the build and the knowledge base", async () => {
    const { pid, bookId } = await setup();
    const base = `/api/projects/${pid}/books/${bookId}`;

    await runJob(`${base}/phase3/run`);
    // Nothing to use as the translation yet.
    expect((await srv!.call("POST", `${base}/reference-pair`, {})).status).toBe(409);

    await runJob(`${base}/build`, { useBestAttempts: false });
    await srv!.json("POST", `${base}/kb/entries`, newEntry("Mira", "Mira"));
    await writeJson(srv!.ctx.paths.phase3Glossary(pid, bookId), Glossary, {
      schemaVersion: 1,
      terms: [
        { kind: "person", source: "Mira", target: "Mira", note: "", chunkIndex: 0, conflict: null },
        {
          kind: "place",
          source: "Brannock",
          target: "Branok",
          note: "",
          chunkIndex: 0,
          conflict: 'chunk 2 used "Brannok"',
        },
      ],
    });
    const kbBefore = await srv!.json<unknown>("GET", `${base}/kb`);

    const preview = await srv!.json<Preview>("GET", `${base}/reference-pair`);
    expect(preview).toMatchObject({
      buildCurrent: true,
      kb: { entries: 1, open: 0, yours: 1 },
      coined: { left: 1, conflicts: 1 },
    });
    expect(preview.build?.fileName).toMatch(/\.pl\.epub$/);

    const { pair } = await srv!.json<{ pair: { id: string } }>("POST", `${base}/reference-pair`, {
      mergeCoined: false,
    });
    const detail = await srv!.json<PairDetail>("GET", `/api/projects/${pid}/pairs/${pair.id}`);
    expect(detail.pair).toMatchObject({
      title: "The Lantern Keeper",
      phase1: { state: "done", entries: 1 },
      fromBook: { bookId, title: "The Lantern Keeper" },
    });
    // Every chapter matches the same chapter of the build; nothing to confirm.
    expect(detail.alignment.status).toBe("confirmed");
    const chapters = detail.source.segmentsByDepth[String(detail.alignment.tocDepthSource)]!;
    expect(detail.alignment.units.map((u) => [u.source, u.target])).toEqual(
      chapters.map((s) => [[s.id], [s.id]]),
    );

    // The translation is the build, byte for byte.
    const built = new Uint8Array(await (await srv!.call("GET", `${base}/output`)).arrayBuffer());
    const target = await fs.readFile(srv!.ctx.paths.pairEpub(pid, pair.id, "target"));
    expect(Buffer.compare(target, Buffer.from(built))).toBe(0);

    const pairKb = await srv!.json<{ kb: { entries: { source: string; origin: string }[] } }>(
      "GET",
      `/api/projects/${pid}/pairs/${pair.id}/kb`,
    );
    expect(pairKb.kb.entries.map((e) => [e.source, e.origin])).toEqual([["Mira", "user"]]);
    // The book is left as it was.
    expect(await srv!.json("GET", `${base}/kb`)).toEqual(kbBefore);

    // A changed translation makes the build out of date.
    const overview = await srv!.json<{ chapters: { id: string }[] }>("GET", `${base}/chapters`);
    const { units } = await srv!.json<{ units: { urlKey: string; source: string }[] }>(
      "GET",
      `${base}/chapters/${overview.chapters[0]!.id}/units`,
    );
    const plain = units.find((u) => !u.source.includes("<"))!;
    await srv!.json("PUT", `${base}/units/${plain.urlKey}`, { text: "Zmieniony tekst." });
    expect((await srv!.json<Preview>("GET", `${base}/reference-pair`)).buildCurrent).toBe(false);

    // With the coined terms, and removing the book afterwards.
    const second = await srv!.json<{ pair: { id: string } }>("POST", `${base}/reference-pair`, {
      mergeCoined: true,
      removeBook: true,
    });
    const secondKb = await srv!.json<{
      kb: { entries: { source: string; origin: string; note: string }[] };
    }>("GET", `/api/projects/${pid}/pairs/${second.pair.id}/kb`);
    expect(secondKb.kb.entries.map((e) => [e.source, e.origin])).toEqual([
      ["Mira", "user"],
      ["Brannock", "phase3"],
    ]);
    expect(secondKb.kb.entries[1]?.note).toContain("Brannok");
    expect((await srv!.call("GET", base)).status).toBe(404);
    await expect(fs.access(path.dirname(srv!.ctx.paths.bookEpub(pid, bookId)))).rejects.toThrow();

    // A book added later gets both pairs as references.
    const form = new FormData();
    form.set("file", new File([sampleNovel()], "next.epub"));
    const { book } = await srv!.json<{ book: { pairIds: string[] } }>(
      "POST",
      `/api/projects/${pid}/books`,
      form,
    );
    expect(book.pairIds).toEqual([pair.id, second.pair.id]);
  });
});
