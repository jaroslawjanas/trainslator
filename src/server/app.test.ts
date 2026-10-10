import { afterEach, describe, expect, it } from "vitest";
import { emptyUsage } from "../shared/schemas/common.ts";
import { MASKED } from "../shared/schemas/settings.ts";
import { type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
import { makeConnection, makeModel } from "../testing/llm-fixtures.ts";
import { makeTestServer, type TestServer } from "../testing/server.ts";
import { createApp } from "./app.ts";

let srv: TestServer | null = null;
let fake: FakeServer | null = null;
afterEach(async () => {
  await fake?.close();
  await srv?.cleanup();
  srv = null;
  fake = null;
});

describe("server", () => {
  it("reports health", async () => {
    srv = await makeTestServer();
    expect(await srv.json("GET", "/api/health")).toMatchObject({ ok: true });
  });

  it("sends pages to the Vite dev server under pnpm dev, but still answers the API", async () => {
    srv = await makeTestServer();
    const app = createApp(srv.ctx, { devWebPort: 5173 });
    const page = await app.request("/projects/pr_1?x=1", { headers: { host: "localhost:5174" } });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("http://localhost:5173/projects/pr_1?x=1");
    const api = await app.request("/api/health", { headers: { host: "localhost:5174" } });
    expect(await api.json()).toMatchObject({ ok: true });
  });

  it("rejects other hosts, missing origins and non-JSON writes", async () => {
    srv = await makeTestServer();
    const evilHost = await srv.app.request("/api/health", {
      headers: { host: "evil.example:5174" },
    });
    expect(evilHost.status).toBe(403);
    const noOrigin = await srv.app.request("/api/projects", {
      method: "POST",
      headers: { host: "127.0.0.1:5174", "content-type": "application/json" },
      body: JSON.stringify({ name: "x", targetLang: "pl" }),
    });
    expect(noOrigin.status).toBe(403);
    const textPlain = await srv.app.request("/api/projects", {
      method: "POST",
      headers: {
        host: "127.0.0.1:5174",
        origin: "http://127.0.0.1:5174",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ name: "x", targetLang: "pl" }),
    });
    expect(textPlain.status).toBe(415);
  });

  it("rejects ids that could escape the data folder", async () => {
    srv = await makeTestServer();
    const res = await srv.call("GET", "/api/projects/..%2F..%2Fetc");
    expect(res.status).toBe(400);
  });

  it("stores connections with masked keys and keeps the key when saved masked", async () => {
    srv = await makeTestServer();
    const connection = makeConnection("https://api.example.com/v1", {
      id: "c1",
      apiKey: { kind: "literal", value: "sk-secret" },
    });
    const saved = await srv.json<{ settings: { connections: { apiKey: { value: string } }[] } }>(
      "PUT",
      "/api/settings/connections/c1",
      connection,
    );
    expect(saved.settings.connections[0]!.apiKey.value).toBe(MASKED);
    await srv.json("PUT", "/api/settings/connections/c1", {
      ...connection,
      name: "Renamed",
      apiKey: { kind: "literal", value: MASKED },
    });
    expect(srv.ctx.settings.connection("c1")!.apiKey).toEqual({
      kind: "literal",
      value: "sk-secret",
    });
    const moved = await srv.call("PUT", "/api/settings/connections/c1", {
      ...connection,
      baseUrl: "https://evil.example/v1",
      apiKey: { kind: "literal", value: MASKED },
    });
    expect(moved.status).toBe(400);
    expect(srv.ctx.settings.connection("c1")!.baseUrl).toBe("https://api.example.com/v1");
  });

  it("sets up an advisor that only the chosen steps may ask", async () => {
    srv = await makeTestServer();
    await srv.json("PUT", "/api/settings/connections/conn1", makeConnection("https://x.test/v1"));
    await srv.json("PUT", "/api/settings/models/model1", makeModel("openai"));
    await srv.json(
      "PUT",
      "/api/settings/models/strong",
      makeModel("openai", { id: "strong", modelName: "strong-model", label: "Strong" }),
    );
    const advisor = srv.ctx.settings.get().advisor;
    expect(advisor.enabled).toBe(false);
    // On without a model: refused.
    expect(
      (await srv.call("PUT", "/api/settings/advisor", { ...advisor, enabled: true })).status,
    ).toBe(400);
    await srv.json("PUT", "/api/settings/advisor", {
      ...advisor,
      enabled: true,
      modelId: "strong",
    });
    const steps = srv.ctx.settings.get().steps;
    await srv.json("PUT", "/api/settings/steps", {
      ...Object.fromEntries(
        Object.entries(steps).map(([k, v]) => [k, { ...v, modelId: "model1" }]),
      ),
      "phase3.translate": { ...steps["phase3.translate"], modelId: "model1", consultAdvisor: true },
    });
    expect(srv.ctx.settings.target("phase3.translate").advisor).toMatchObject({
      model: { id: "strong" },
      maxConsultations: 3,
    });
    expect(srv.ctx.settings.target("phase1.read").advisor).toBeNull();
    // Removing its model switches the advisor off.
    await srv.json("DELETE", "/api/settings/models/strong");
    expect(srv.ctx.settings.get().advisor).toMatchObject({ enabled: false, modelId: null });
    expect(srv.ctx.settings.target("phase3.translate").advisor).toBeNull();
  });

  it("counts Claude Code requests as $0 on the Usage page, also those logged before", async () => {
    srv = await makeTestServer();
    await srv.json(
      "PUT",
      "/api/settings/connections/cc",
      makeConnection("claude", { id: "cc", kind: "claude_code" }),
    );
    await srv.json(
      "PUT",
      "/api/settings/models/opus",
      makeModel("claude_code", { id: "opus", connectionId: "cc", modelName: "opus" }),
    );
    const { project } = await srv.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "P",
      targetLang: "pl",
    });
    const logged = (modelId: string, cost: number) => ({
      id: `call_${modelId}`,
      at: new Date().toISOString(),
      projectId: project.id,
      jobId: null,
      step: "phase2.chapter",
      label: "chapter 1",
      modelId,
      modelName: modelId,
      attempt: 1,
      kind: "request" as const,
      requestHash: "h",
      blockTokens: [],
      params: {},
      finishReason: "stop",
      latencyMs: 1,
      waitMs: 0,
      usage: { ...emptyUsage(), calls: 1, cost },
      error: null,
    });
    // An older Claude Code request, logged with what the API would have charged.
    await srv.ctx.rt.log.append(logged("opus", 2.5));
    await srv.ctx.rt.log.append(logged("other", 0.5));
    const usage = await srv.json<{ total: { cost: number; calls: number } }>(
      "GET",
      `/api/usage/${project.id}`,
    );
    expect(usage.total).toMatchObject({ calls: 2, cost: 0.5 });
  });

  it("creates projects and runs the language notes job", async () => {
    fake = await startFakeOpenAI(() => ({
      content: JSON.stringify({ markdown: "- Use gendered verb forms." }),
    }));
    srv = await makeTestServer();
    await srv.json("PUT", "/api/settings/connections/conn1", makeConnection(fake.url));
    await srv.json("PUT", "/api/settings/models/model1", makeModel("openai"));
    const steps = srv.ctx.settings.get().steps;
    await srv.json("PUT", "/api/settings/steps", {
      ...steps,
      utility: { ...steps.utility, modelId: "model1" },
    });

    const { project } = await srv.json<{
      project: { id: string; targetLangName: string; direction: string };
    }>("POST", "/api/projects", { name: "Test", targetLang: "pl" });
    expect(project).toMatchObject({ targetLangName: "Polish", direction: "ltr" });
    const { job } = await srv.json<{ job: { id: string } }>(
      "POST",
      `/api/projects/${project.id}/language-notes/generate`,
    );
    const done = await srv.ctx.runner.wait(job.id);
    expect(done?.status).toBe("done");
    const notes = await srv.json<{ markdown: string }>(
      "GET",
      `/api/projects/${project.id}/language-notes`,
    );
    expect(notes.markdown).toContain("gendered verb forms");
  });

  it("explains what to set up when no model is chosen", async () => {
    srv = await makeTestServer();
    const { project } = await srv.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "Test",
      targetLang: "he",
    });
    const res = await srv.call("POST", `/api/projects/${project.id}/language-notes/generate`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "Step defaults",
    );
  });
});
