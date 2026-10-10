import { afterEach, describe, expect, it } from "vitest";
import { EpubBook } from "../epub/book.ts";
import { sampleNovel } from "../testing/epub-fixtures.ts";
import { type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
import { shout, translateReply } from "../testing/fake-translator.ts";
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
  urlKey: string;
  source: string;
  translation: string | null;
  status: string;
}

interface HistoryView {
  translations: {
    id: string;
    number: number;
    reason: string;
    modes: string[];
    models: string[];
    counts: { units: number; edited: number };
    builds: { id: string; fileName: string }[];
  }[];
  current: { savedAs: string | null } | null;
}

/** The fake model's style: plain uppercase, or uppercase with " BIS" after each passage. */
let style: "plain" | "bis" = "plain";

async function setup() {
  style = "plain";
  fake = await startFakeOpenAI((body) =>
    translateReply(body, (_id, text) => (style === "bis" ? `${shout(text)} BIS` : shout(text))),
  );
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
  return `/api/projects/${project.id}/books/${book.id}`;
}

async function runJob(path: string, body?: unknown) {
  const { job } = await srv!.json<{ job: { id: string } }>("POST", path, body);
  const done = await srv!.ctx.runner.wait(job.id);
  expect(done?.error ?? null).toBeNull();
  return done!;
}

async function chapterOneId(base: string) {
  const { chapters } = await srv!.json<{ chapters: { id: string; title: string }[] }>(
    "GET",
    `${base}/chapters`,
  );
  return chapters.find((c) => c.title === "Chapter One")!.id;
}

async function chapterOne(base: string) {
  const id = await chapterOneId(base);
  return (await srv!.json<{ units: UnitView[] }>("GET", `${base}/chapters/${id}/units`)).units.find(
    (u) => u.source.startsWith("The keeper"),
  )!;
}

/** The same passage in several versions, as the Review page shows it. */
async function versionsOf(base: string, versions: string[]) {
  const id = await chapterOneId(base);
  const { units } = await srv!.json<{
    units: { source: string; versions: Record<string, { text: string | null }> }[];
  }>("GET", `${base}/chapters/${id}/review?versions=${versions.join(",")}`);
  return units.find((u) => u.source.startsWith("The keeper"))!.versions;
}

describe("translation history", () => {
  it("saves each translation and build, compares and restores an older one", async () => {
    const base = await setup();
    await runJob(`${base}/phase3/run`);
    let history = await srv!.json<HistoryView>("GET", `${base}/history`);
    expect(history.translations).toHaveLength(1);
    const first = history.translations[0]!;
    expect(first).toMatchObject({ number: 1, reason: "run", modes: ["chunks"] });
    expect(first.models).toHaveLength(1);
    expect(history.current?.savedAs).toBe(first.id);
    // Saving it by hand again changes nothing.
    expect(await srv!.json("POST", `${base}/history/translations`)).toEqual({ id: first.id });

    // A build of an unchanged translation is linked to it, and kept.
    await runJob(`${base}/build`, { useBestAttempts: false });
    history = await srv!.json<HistoryView>("GET", `${base}/history`);
    expect(history.translations).toHaveLength(1);
    const build = history.translations[0]!.builds[0]!;
    const res = await srv!.call("GET", `${base}/history/builds/${build.id}`);
    expect(res.status).toBe(200);
    expect(EpubBook.open(new Uint8Array(await res.arrayBuffer())).title).toBeTruthy();

    // An edit makes a new translation, saved when the book is built again.
    const unit = await chapterOne(base);
    await srv!.json("PUT", `${base}/units/${unit.urlKey}`, { text: "Poprawione ręcznie." });
    expect((await srv!.json<HistoryView>("GET", `${base}/history`)).current?.savedAs).toBeNull();
    await runJob(`${base}/build`, { useBestAttempts: false });
    history = await srv!.json<HistoryView>("GET", `${base}/history`);
    expect(history.translations.map((t) => t.reason)).toEqual(["run", "build"]);
    const second = history.translations[1]!;
    expect(second.counts.edited).toBe(1);
    expect(second.builds).toHaveLength(1);

    // Compare: the saved text next to the current one.
    const side = await versionsOf(base, ["current", first.id]);
    expect(side.current!.text).toBe("Poprawione ręcznie.");
    expect(side[first.id]!.text).toBe(unit.translation);

    // Restore the first translation: the edit goes, and nothing is lost.
    await srv!.json("POST", `${base}/history/translations/${first.id}/restore`);
    const restored = await chapterOne(base);
    expect(restored.translation).toBe(unit.translation);
    expect(restored.status).toBe("ok");
    expect((await versionsOf(base, [second.id]))[second.id]!.text).toBe("Poprawione ręcznie.");
    history = await srv!.json<HistoryView>("GET", `${base}/history`);
    expect(history.translations).toHaveLength(2);
    expect(history.current?.savedAs).toBe(first.id);

    // And back again.
    await srv!.json("POST", `${base}/history/translations/${second.id}/restore`);
    expect((await chapterOne(base)).translation).toBe("Poprawione ręcznie.");
  });

  it("saves the current translation before translating the whole book again", async () => {
    const base = await setup();
    await runJob(`${base}/phase3/run`);
    const unit = await chapterOne(base);
    await srv!.json("PUT", `${base}/units/${unit.urlKey}`, { text: "Poprawione ręcznie." });

    style = "bis";
    await runJob(`${base}/phase3/redo`);
    const history = await srv!.json<HistoryView>("GET", `${base}/history`);
    expect(history.translations.map((t) => t.reason)).toEqual(["run", "redo", "run"]);
    expect(history.translations[1]!.counts.edited).toBe(1);
    expect(history.current?.savedAs).toBe(history.translations[2]!.id);
    const fresh = await chapterOne(base);
    expect(fresh.status).toBe("ok");
    expect(fresh.translation).toMatch(/ BIS$/);
  });
});
