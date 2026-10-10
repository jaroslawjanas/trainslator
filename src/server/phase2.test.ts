import { afterEach, describe, expect, it } from "vitest";
import type { BookSetup, EpubStructure } from "../shared/schemas/epub.ts";
import type { Kb } from "../shared/schemas/kb.ts";
import { sampleNovel } from "../testing/epub-fixtures.ts";
import { type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
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

function content(body: Record<string, unknown>): string {
  return (body.messages as { content: string }[]).map((m) => m.content).join("\n");
}

function idFor(text: string, source: string): string | null {
  const m = new RegExp(`\\[(p\\d+)\\](?: \\[locked\\])? ${source}`).exec(text);
  return m?.[1] ?? null;
}

/** Chapter 1 adds names (with one duplicate) and an open question; chapter 2 resolves it. */
function fakePhase2(body: Record<string, unknown>) {
  const t = content(body);
  if (t.includes("You review a knowledge base")) return { content: JSON.stringify({ edits: [] }) };
  if (!t.includes("You prepare a knowledge base"))
    return { status: 400, errorMessage: "unexpected" };
  const chapter = t.slice(t.lastIndexOf("# Chapter:"));
  if (chapter.includes("Mira climbed")) {
    const edits = [
      {
        op: "add",
        id: null,
        reason: "main character",
        fields: {
          kind: "person",
          source: "Mira",
          aliases: null,
          target: "Mira",
          treatment: "kept",
          attributes: [{ key: "gender", value: "female" }],
          note: null,
          status: null,
          question: null,
        },
      },
      {
        op: "add",
        id: null,
        reason: "cat",
        fields: {
          kind: "person",
          source: "Pepper",
          aliases: null,
          target: "Pieprz",
          treatment: "translated",
          attributes: null,
          note: null,
          status: "open",
          question: "Is the cat male or female?",
        },
      },
      {
        op: "add",
        id: null,
        reason: "ship",
        fields: {
          kind: "named_thing",
          source: "Gray Heron",
          aliases: null,
          target: "Szara Czapla",
          treatment: "translated",
          attributes: null,
          note: null,
          status: null,
          question: null,
        },
      },
    ];
    edits.push({ ...edits[0]!, reason: "duplicate by mistake" });
    return {
      content: JSON.stringify({ synopsis: "Mira keeps the lighthouse; her cat is Pepper.", edits }),
    };
  }
  const pepper = idFor(t, "Pepper");
  const edits = pepper
    ? [
        {
          op: "resolve",
          id: pepper,
          reason: "revealed",
          // Keys with null values left out, as many models do.
          fields: { attributes: [{ key: "gender", value: "female" }] },
        },
      ]
    : [];
  return { content: JSON.stringify({ synopsis: "A storm comes at midnight.", edits }) };
}

async function setup(includeAll = true): Promise<{ pid: string; bookId: string }> {
  fake = await startFakeOpenAI(fakePhase2);
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
  const detail = await srv.json<{ structure: EpubStructure; setup: BookSetup }>(
    "GET",
    `/api/projects/${project.id}/books/${book.id}`,
  );
  const segs = detail.structure.segmentsByDepth["1"]!.filter((s) => s.linear);
  await srv.json("PUT", `/api/projects/${project.id}/books/${book.id}/setup`, {
    ...detail.setup,
    tocDepth: 1,
    phase2Segments: (includeAll ? segs : segs.slice(0, 1)).map((s) => s.id),
  });
  return { pid: project.id, bookId: book.id };
}

async function run(path: string): Promise<Kb> {
  const { job } = await srv!.json<{ job: { id: string } }>("POST", path);
  const done = await srv!.ctx.runner.wait(job.id);
  expect(done?.error ?? null).toBeNull();
  const [, , , pid, , bookId] = path.split("/");
  return (await srv!.json<{ kb: Kb }>("GET", `/api/projects/${pid}/books/${bookId}/kb`)).kb;
}

describe("phase 2", () => {
  it("reads chapters in order, merges duplicates, and resolves open questions later", async () => {
    const { pid, bookId } = await setup();
    const kb = await run(`/api/projects/${pid}/books/${bookId}/phase2/run`);
    expect(kb.entries.map((e) => e.source).sort()).toEqual(["Gray Heron", "Mira", "Pepper"]);
    const pepper = kb.entries.find((e) => e.source === "Pepper")!;
    expect(pepper).toMatchObject({
      status: "auto",
      question: null,
      attributes: [{ key: "gender", value: "female" }],
    });
    const { steps, review } = await srv!.json<{
      steps: { synopsis: string; outcomes: { result: string }[] }[];
      review: unknown;
    }>("GET", `/api/projects/${pid}/books/${bookId}/phase2/steps`);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.synopsis).toContain("lighthouse");
    expect(review).not.toBeNull();
    // The duplicate in the first answer was merged into the existing entry, without a repair turn.
    expect(
      steps[0]!.outcomes.some((o) =>
        (o as { message?: string }).message?.startsWith("already listed"),
      ),
    ).toBe(true);
    expect(fake!.requests.some((r) => (r.messages as unknown[]).length > 2)).toBe(false);
  });

  it("keeps your answers when re-running from a chapter", async () => {
    const { pid, bookId } = await setup(false);
    const kb = await run(`/api/projects/${pid}/books/${bookId}/phase2/run`);
    const pepper = kb.entries.find((e) => e.source === "Pepper")!;
    expect(pepper.status).toBe("open");
    await srv!.json("POST", `/api/projects/${pid}/books/${bookId}/kb/entries/${pepper.id}/answer`, {
      target: "Pieprzyk",
      note: "A tomcat.",
      attributes: [{ key: "gender", value: "male" }],
    });
    const again = await run(`/api/projects/${pid}/books/${bookId}/phase2/rerun-from/0`);
    expect(again.entries.find((e) => e.id === pepper.id)).toMatchObject({
      target: "Pieprzyk",
      status: "locked",
    });
    expect(again.entries.filter((e) => e.source === "Pepper")).toHaveLength(1);
  });

  it("saves an answer without locking it, and keeps it when reviewing again", async () => {
    const { pid, bookId } = await setup(false);
    const base = `/api/projects/${pid}/books/${bookId}`;
    const kb = await run(`${base}/phase2/run`);
    const pepper = kb.entries.find((e) => e.source === "Pepper")!;
    expect(pepper.status).toBe("open");
    const saved = await srv!.json<{ kb: Kb }>("PUT", `${base}/kb/entries/${pepper.id}/unlocked`, {
      ...pepper,
      target: "Pieprzyk",
    });
    expect(saved.kb.entries.find((e) => e.id === pepper.id)).toMatchObject({
      target: "Pieprzyk",
      status: "auto",
      question: null,
    });
    // Not one of your locked changes.
    expect(await srv!.json("GET", `${base}/phase2/own-changes`)).toMatchObject({ entries: 0 });
    const { job } = await srv!.json<{ job: { id: string } }>("POST", `${base}/phase2/run`, {
      again: true,
    });
    await srv!.ctx.runner.wait(job.id);
    const after = (await srv!.json<{ kb: Kb }>("GET", `${base}/kb`)).kb;
    expect(after.entries.find((e) => e.id === pepper.id)).toMatchObject({
      target: "Pieprzyk",
      status: "auto",
    });
    // A locked entry is saved locked or unlocked first.
    const mira = after.entries.find((e) => e.source === "Mira")!;
    await srv!.json("PUT", `${base}/kb/entries/${mira.id}`, { ...mira, target: "Mirka" });
    const refused = await srv!.call("PUT", `${base}/kb/entries/${mira.id}/unlocked`, {
      ...mira,
      target: "Mireczka",
    });
    expect(refused.status).toBe(400);
  });

  it("reads the whole book again with fresh answers, keeping your changes, and can go back", async () => {
    const { pid, bookId } = await setup();
    const base = `/api/projects/${pid}/books/${bookId}`;
    const first = await run(`${base}/phase2/run`);

    // Continuing a finished read asks nothing; reviewing again does, even unchanged.
    const sent = fake!.requests.length;
    await run(`${base}/phase2/run`);
    expect(fake!.requests.length).toBe(sent);
    const { job: again } = await srv!.json<{ job: { id: string } }>("POST", `${base}/phase2/run`, {
      again: true,
    });
    await srv!.ctx.runner.wait(again.id);
    expect(fake!.requests.length).toBeGreaterThan(sent);

    const mira = first.entries.find((e) => e.source === "Mira")!;
    const heron = first.entries.find((e) => e.source === "Gray Heron")!;
    // Your changes: Mira's translation set by hand, the ship deleted.
    await srv!.json("PUT", `${base}/kb/entries/${mira.id}`, { ...mira, target: "Mirka" });
    await srv!.json("DELETE", `${base}/kb/entries/${heron.id}`);
    expect(await srv!.json("GET", `${base}/phase2/own-changes`)).toEqual({
      entries: 1,
      deletions: 1,
      styleRules: 0,
    });

    // The whole book again: every chapter is asked anew, not taken from saved answers.
    const before = fake!.requests.length;
    const { job } = await srv!.json<{ job: { id: string } }>("POST", `${base}/phase2/rebuild`, {
      dropOwn: false,
    });
    expect((await srv!.ctx.runner.wait(job.id))?.error ?? null).toBeNull();
    expect(fake!.requests.length - before).toBeGreaterThanOrEqual(3);
    let kb = (await srv!.json<{ kb: Kb }>("GET", `${base}/kb`)).kb;
    expect(kb.entries.find((e) => e.source === "Mira")).toMatchObject({
      target: "Mirka",
      status: "locked",
    });
    expect(kb.entries.some((e) => e.source === "Gray Heron")).toBe(false);

    // The knowledge base from before was saved, and comes back with a restore.
    const history = await srv!.json<{
      knowledgeBases: { id: string; reason: string }[];
    }>("GET", `${base}/history`);
    expect(history.knowledgeBases.map((k) => k.reason)).toEqual(["rebuild"]);

    // Starting clean drops your changes: the ship is back, Mira is the AI's again.
    const { job: clean } = await srv!.json<{ job: { id: string } }>(
      "POST",
      `${base}/phase2/rebuild`,
      { dropOwn: true },
    );
    await srv!.ctx.runner.wait(clean.id);
    kb = (await srv!.json<{ kb: Kb }>("GET", `${base}/kb`)).kb;
    expect(kb.entries.find((e) => e.source === "Mira")!.target).toBe("Mira");
    expect(kb.entries.some((e) => e.source === "Gray Heron")).toBe(true);

    // Restoring the first saved copy brings your changes back.
    await srv!.json("POST", `${base}/history/knowledge/${history.knowledgeBases[0]!.id}/restore`);
    kb = (await srv!.json<{ kb: Kb }>("GET", `${base}/kb`)).kb;
    expect(kb.entries.find((e) => e.source === "Mira")!.target).toBe("Mirka");
    expect(kb.entries.some((e) => e.source === "Gray Heron")).toBe(false);
    expect(await srv!.json("GET", `${base}/phase2/own-changes`)).toMatchObject({ deletions: 1 });
  });
});
