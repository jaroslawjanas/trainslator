import { afterEach, describe, expect, it } from "vitest";
import { EpubBook } from "../epub/book.ts";
import { readZip } from "../epub/zip.ts";
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

interface UnitView {
  key: string;
  urlKey: string;
  source: string;
  translation: string | null;
  status: string;
}

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

async function runJob(path: string, body?: unknown) {
  const { job } = await srv!.json<{ job: { id: string } }>("POST", path, body);
  const done = await srv!.ctx.runner.wait(job.id);
  expect(done?.error ?? null).toBeNull();
  return done!;
}

describe("translation through the app", () => {
  it("translates, reviews, builds and downloads a book without reference pairs", async () => {
    const { pid, bookId } = await setup();
    const base = `/api/projects/${pid}/books/${bookId}`;
    const est = await srv!.json<{ chunks: number }>("GET", `${base}/phase3/estimate`);
    expect(est.chunks).toBeGreaterThan(0);

    const job = await runJob(`${base}/phase3/run`);
    expect(job.status).toBe("done");

    const overview = await srv!.json<{
      chapters: { id: string; title: string; ok: number; pending: number }[];
    }>("GET", `${base}/chapters`);
    expect(overview.chapters.every((c) => c.pending === 0)).toBe(true);
    const first = overview.chapters.find((c) => c.title === "Chapter One")!;
    const { units } = await srv!.json<{ units: UnitView[] }>(
      "GET",
      `${base}/chapters/${first.id}/units`,
    );
    const cat = units.find((u) => u.source.startsWith("The keeper"))!;
    expect(cat.translation).toContain("THE KEEPER");

    // A manual edit with broken placeholders is refused; a valid one is used.
    const noteUnit = units.find((u) => u.source.includes("<x4/>"))!;
    expect(
      (await srv!.call("PUT", `${base}/units/${noteUnit.urlKey}`, { text: "Bez przypisu." }))
        .status,
    ).toBe(400);
    await srv!.json("PUT", `${base}/units/${cat.urlKey}`, {
      text: "Kot latarnika nazywał się Pieprz.",
    });

    const toc = await srv!.json<{
      translatedTitle: string | null;
      items: { key: string; translation: string | null }[];
    }>("GET", `${base}/toc`);
    expect(toc.translatedTitle).toBe("THE LANTERN KEEPER");
    await srv!.json("PUT", `${base}/toc`, {
      title: "Latarniczka",
      items: { [toc.items[0]!.key]: "Spis treści" },
    });

    await runJob(`${base}/build`, { useBestAttempts: false });
    const res = await srv!.call("GET", `${base}/output`);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const out = EpubBook.open(bytes);
    expect(out.title).toBe("Latarniczka");
    const ch1 = new TextDecoder().decode(
      readZip(bytes).find((e) => e.name === "OEBPS/text/ch1.xhtml")!.data,
    );
    expect(ch1).toContain("Kot latarnika nazywał się Pieprz.");
    expect(ch1).toContain('<span class="dropcap">M</span>IRA CLIMBED');
  });

  it("re-translates one unit with an instruction", async () => {
    const { pid, bookId } = await setup();
    const base = `/api/projects/${pid}/books/${bookId}`;
    await runJob(`${base}/phase3/run`);
    const overview = await srv!.json<{ chapters: { id: string; title: string }[] }>(
      "GET",
      `${base}/chapters`,
    );
    const chapterOne = overview.chapters.find((c) => c.title === "Chapter One")!;
    const { units } = await srv!.json<{ units: UnitView[] }>(
      "GET",
      `${base}/chapters/${chapterOne.id}/units`,
    );
    const target = units[1]!;
    const before = fake!.requests.length;
    await runJob(`${base}/units/${target.urlKey}/retranslate`, { instruction: "More formal" });
    expect(fake!.requests.length).toBe(before + 1);
    expect(JSON.stringify(fake!.requests.at(-1)!.messages)).toContain("More formal");
  });
});
