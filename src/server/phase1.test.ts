import { afterEach, describe, expect, it } from "vitest";
import type { Alignment } from "../shared/schemas/alignment.ts";
import type { Kb } from "../shared/schemas/kb.ts";
import { sampleNovel, sampleNovelTranslation } from "../testing/epub-fixtures.ts";
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

async function setup(): Promise<{ pid: string; pairId: string }> {
  fake = await startFakeOpenAI(fakePhase1);
  srv = await makeTestServer();
  await srv.json("PUT", "/api/settings/connections/conn1", makeConnection(fake.url));
  await srv.json("PUT", "/api/settings/models/model1", makeModel("openai"));
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

async function runPhase1(pid: string, pairId: string) {
  const { job } = await srv!.json<{ job: { id: string } }>(
    "POST",
    `/api/projects/${pid}/pairs/${pairId}/phase1/run`,
  );
  const done = await srv!.ctx.runner.wait(job.id);
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
