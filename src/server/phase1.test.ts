import { afterEach, describe, expect, it } from "vitest";
import type { Alignment } from "../shared/schemas/alignment.ts";
import type { Job } from "../shared/schemas/jobs.ts";
import type { Kb } from "../shared/schemas/kb.ts";
import { sampleNovel, sampleNovelTranslation } from "../testing/epub-fixtures.ts";
import { type FakeHandler, type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
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

function text(body: Record<string, unknown>): string {
  return JSON.stringify(body.messages);
}

/** A fake model that "reads" chapters, merges groups and summarizes style. */
function fakePhase1(body: Record<string, unknown>) {
  const t = text(body);
  if (t.includes("You study how a professional translator")) {
    const findings = [];
    if (t.includes("Mira")) {
      findings.push({
        kind: "person",
        source: "Mira",
        target: "Mira",
        targetSeen: [],
        treatment: "kept",
        attributes: [{ key: "gender", value: "female" }],
        note: "Name kept.",
        sourceQuote: "Mira climbed",
        targetQuote: "Mira wspinała się",
      });
    }
    if (t.includes("Gray Heron")) {
      findings.push({
        kind: "named_thing",
        source: "Gray Heron",
        target: "Szara Czapla",
        targetSeen: ["Szarej Czapli"],
        treatment: "translated",
        attributes: [],
        note: "Ship name translated.",
        sourceQuote: "the Gray Heron",
        targetQuote: "Szara Czapla",
      });
    }
    if (t.includes("storm")) {
      findings.push({
        kind: "term",
        source: "the storm",
        target: "sztorm",
        targetSeen: [],
        treatment: "translated",
        attributes: [],
        note: "",
        sourceQuote: "The storm came",
        targetQuote: "Sztorm przyszedł",
      });
    }
    return {
      content: JSON.stringify({
        findings,
        styleNotes: [{ rule: "Dialogue uses dashes", sourceQuote: "x", targetQuote: "y" }],
      }),
    };
  }
  if (t.includes("You turn notes about a published")) {
    const batch = t.slice(t.indexOf("# Decide these groups"));
    const ids = [...batch.matchAll(/(?:^|\\n)(g\d+) \[/g)].map((m) => m[1]);
    return {
      content: JSON.stringify({
        decisions: ids.map((g) => ({
          group: g,
          action: "entry",
          into: null,
          reason: null,
          entry: null,
        })),
      }),
    };
  }
  if (t.includes("You summarize the conventions")) {
    return {
      content: JSON.stringify({
        rules: [{ rule: "Set dialogue with dashes.", sourceExample: null, targetExample: null }],
      }),
    };
  }
  return { status: 400, errorMessage: "unexpected request" };
}

async function setup(
  handler: FakeHandler = fakePhase1,
  model: Parameters<typeof makeModel>[1] = {},
  connection: Parameters<typeof makeConnection>[1] = {},
): Promise<{ pid: string; pairId: string }> {
  fake = await startFakeOpenAI(handler);
  srv = await makeTestServer();
  await srv.json("PUT", "/api/settings/connections/conn1", makeConnection(fake.url, connection));
  await srv.json("PUT", "/api/settings/models/model1", makeModel("openai", model));
  const steps = srv.ctx.settings.get().steps;
  const all = Object.fromEntries(
    Object.entries(steps).map(([k, v]) => [k, { ...v, modelId: "model1" }]),
  );
  await srv.json("PUT", "/api/settings/steps", all);
  const { project } = await srv.json<{ project: { id: string } }>("POST", "/api/projects", {
    name: "P",
    targetLang: "pl",
  });
  const form = new FormData();
  form.set("source", new File([sampleNovel()], "novel.epub"));
  form.set("target", new File([sampleNovelTranslation()], "powiesc.epub"));
  const { pair } = await srv.json<{ pair: { id: string } }>(
    "POST",
    `/api/projects/${project.id}/pairs`,
    form,
  );
  const { alignment } = await srv.json<{ alignment: Alignment }>(
    "GET",
    `/api/projects/${project.id}/pairs/${pair.id}`,
  );
  await srv.json("PUT", `/api/projects/${project.id}/pairs/${pair.id}/alignment`, {
    ...alignment,
    status: "confirmed",
    units: alignment.units.map((u) => ({
      ...u,
      include: u.source.length > 0 && u.target.length > 0,
    })),
  });
  return { pid: project.id, pairId: pair.id };
}

async function startPhase1(pid: string, pairId: string) {
  const { job } = await srv!.json<{ job: { id: string } }>(
    "POST",
    `/api/projects/${pid}/pairs/${pairId}/phase1/run`,
  );
  return srv!.ctx.runner.wait(job.id);
}

async function runPhase1(pid: string, pairId: string) {
  const done = await startPhase1(pid, pairId);
  expect(done?.error ?? null).toBeNull();
  expect(done?.status).toBe("done");
  return (await srv!.json<{ kb: Kb }>("GET", `/api/projects/${pid}/pairs/${pairId}/kb`)).kb;
}

describe("phase 1", () => {
  it("builds a knowledge base from a reference pair", async () => {
    const { pid, pairId } = await setup();
    const kb = await runPhase1(pid, pairId);
    const heron = kb.entries.find((e) => e.source === "Gray Heron");
    expect(heron).toMatchObject({
      target: "Szara Czapla",
      kind: "named_thing",
      targetSeen: ["Szarej Czapli"],
    });
    expect(kb.entries.find((e) => e.source === "Mira")?.attributes).toEqual([
      { key: "gender", value: "female" },
    ]);
    expect(kb.styleRules.map((r) => r.rule)).toEqual(["Set dialogue with dashes."]);
    const preview = await srv!.json<{ text: string }>(
      "GET",
      `/api/projects/${pid}/pairs/${pairId}/kb/preview`,
    );
    expect(preview.text).toContain("Gray Heron → Szara Czapla");
  });

  it("keeps your edits and deletions when phase 1 runs again", async () => {
    const { pid, pairId } = await setup();
    const kb = await runPhase1(pid, pairId);
    const heron = kb.entries.find((e) => e.source === "Gray Heron")!;
    const storm = kb.entries.find((e) => e.source === "the storm")!;
    await srv!.json("PUT", `/api/projects/${pid}/pairs/${pairId}/kb/entries/${heron.id}`, {
      ...heron,
      target: "Siwa Czapla",
    });
    await srv!.json("DELETE", `/api/projects/${pid}/pairs/${pairId}/kb/entries/${storm.id}`);
    const requestsBefore = fake!.requests.length;

    const again = await runPhase1(pid, pairId);
    expect(again.entries.find((e) => e.id === heron.id)).toMatchObject({
      target: "Siwa Czapla",
      status: "locked",
    });
    expect(again.entries.some((e) => e.source === "the storm")).toBe(false);
    // Chapter readings were reused; only the merge ran again (the index changed).
    const newRequests = fake!.requests.slice(requestsBefore).map((r) => text(r));
    expect(newRequests.some((t) => t.includes("You study how a professional translator"))).toBe(
      false,
    );
  });

  it("reports its stages, each chapter's findings and every request it made", async () => {
    const { pid, pairId } = await setup();
    await runPhase1(pid, pairId);
    const { jobs } = await srv!.json<{ jobs: Job[] }>("GET", `/api/jobs?projectId=${pid}`);
    const job = jobs.find((j) => j.type === "phase1")!;
    expect(job.progress.stages.map((st) => [st.key, st.state])).toEqual([
      ["read", "done"],
      ["merge", "done"],
      ["style", "done"],
      ["save", "done"],
    ]);
    const read = job.progress.stages[0]!;
    expect(read.done).toBe(read.total);

    const { chapters } = await srv!.json<{
      chapters: { position: number; read: boolean; findings: number; source: string[] }[];
    }>("GET", `/api/projects/${pid}/pairs/${pairId}/phase1/chapters`);
    expect(chapters.length).toBe(read.total);
    expect(chapters.every((c) => c.read)).toBe(true);
    const withHeron = [];
    for (const c of chapters) {
      const { findings } = await srv!.json<{ findings: { source: string }[] }>(
        "GET",
        `/api/projects/${pid}/pairs/${pairId}/phase1/chapters/${c.position}`,
      );
      expect(findings).toHaveLength(c.findings);
      if (findings.some((x) => x.source === "Gray Heron")) withHeron.push(c.position);
    }
    expect(withHeron.length).toBeGreaterThan(0);

    const activity = await srv!.json<{
      active: unknown[];
      finished: { label: string; error: string | null }[];
    }>("GET", `/api/jobs/${job.id}/activity`);
    expect(activity.active).toEqual([]);
    expect(activity.finished).toHaveLength(fake!.requests.length);
    expect(activity.finished.filter((c) => c.label.startsWith("read "))).toHaveLength(read.total);
    expect(activity.finished.every((c) => c.error === null)).toBe(true);
  });

  it("stops at the first wrong-address error instead of trying every chapter", async () => {
    const { pid, pairId } = await setup(
      () => ({ status: 405, errorMessage: "Method Not Allowed" }),
      {},
      { maxParallel: 1 },
    );
    const done = await startPhase1(pid, pairId);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("405");
    expect(fake!.requests).toHaveLength(1);
  });

  it("shows a cancelled run as stopped, not running", async () => {
    const { pid, pairId } = await setup((body) => ({ ...fakePhase1(body), delayMs: 2000 }));
    const { job } = await srv!.json<{ job: { id: string } }>(
      "POST",
      `/api/projects/${pid}/pairs/${pairId}/phase1/run`,
    );
    const pairState = async () =>
      (
        await srv!.json<{ pair: { phase1: { state: string } } }>(
          "GET",
          `/api/projects/${pid}/pairs/${pairId}`,
        )
      ).pair.phase1.state;
    for (let i = 0; i < 100 && fake!.requests.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(await pairState()).toBe("running");
    await srv!.json("POST", `/api/jobs/${job.id}/cancel`);
    expect((await srv!.ctx.runner.wait(job.id))?.status).toBe("cancelled");
    expect(await pairState()).toBe("stopped");
    const { pairs } = await srv!.json<{ pairs: { phase1: { state: string } }[] }>(
      "GET",
      `/api/projects/${pid}`,
    );
    expect(pairs[0]!.phase1.state).toBe("stopped");
  });

  it("counts usage again from zero after a reset, keeping the call log", async () => {
    const { pid, pairId } = await setup();
    type UsageView = { since: string | null; total: { calls: number }; recent: unknown[] };
    const usage = () => srv!.json<UsageView>("GET", `/api/usage/${pid}`);
    await runPhase1(pid, pairId);
    const before = await usage();
    expect(before.since).toBeNull();
    expect(before.total.calls).toBe(fake!.requests.length);

    await srv!.json("POST", `/api/usage/${pid}/reset`);
    const after = await usage();
    expect(after.since).not.toBeNull();
    expect(after.total.calls).toBe(0);
    expect(after.recent).toEqual([]);
    expect(await srv!.ctx.rt.log.read(pid)).toHaveLength(fake!.requests.length);

    const sent = fake!.requests.length;
    await runPhase1(pid, pairId);
    expect((await usage()).total.calls).toBe(fake!.requests.length - sent);
  });

  it("refuses to start before the alignment is confirmed", async () => {
    const { pid, pairId } = await setup();
    const { alignment } = await srv!.json<{ alignment: Alignment }>(
      "GET",
      `/api/projects/${pid}/pairs/${pairId}`,
    );
    await srv!.json("PUT", `/api/projects/${pid}/pairs/${pairId}/alignment`, {
      ...alignment,
      status: "proposed",
    });
    const res = await srv!.call("POST", `/api/projects/${pid}/pairs/${pairId}/phase1/run`);
    expect(res.status).toBe(409);
  });
});
