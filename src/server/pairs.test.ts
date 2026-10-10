import { afterEach, describe, expect, it } from "vitest";
import type { Alignment } from "../shared/schemas/alignment.ts";
import { buildFixtureEpub, sampleNovel, sampleNovelTranslation } from "../testing/epub-fixtures.ts";
import { makeTestServer, type TestServer } from "../testing/server.ts";

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.cleanup();
  srv = null;
});

async function project(s: TestServer): Promise<string> {
  const { project } = await s.json<{ project: { id: string } }>("POST", "/api/projects", {
    name: "P",
    targetLang: "pl",
  });
  return project.id;
}

function form(source: Uint8Array, target: Uint8Array): FormData {
  const f = new FormData();
  f.set("source", new File([source], "novel.epub", { type: "application/epub+zip" }));
  f.set("target", new File([target], "powiesc.epub", { type: "application/epub+zip" }));
  return f;
}

describe("reference pairs", () => {
  it("imports a pair and proposes an alignment", async () => {
    srv = await makeTestServer();
    const pid = await project(srv);
    const { pair } = await srv.json<{ pair: { id: string; title: string } }>(
      "POST",
      `/api/projects/${pid}/pairs`,
      form(sampleNovel(), sampleNovelTranslation()),
    );
    expect(pair.title).toBe("The Lantern Keeper");
    const detail = await srv.json<{
      alignment: Alignment;
      source: { maxDepth: number };
      target: { maxDepth: number };
    }>("GET", `/api/projects/${pid}/pairs/${pair.id}`);
    expect(detail.alignment.status).toBe("proposed");
    expect(detail.alignment.units.length).toBeGreaterThan(1);

    const preview = await srv.json<{ source: { start: string }; target: { start: string } }>(
      "GET",
      `/api/projects/${pid}/pairs/${pair.id}/units/${detail.alignment.units[0]!.id}/preview`,
    );
    expect(preview.source.start.length).toBeGreaterThan(0);

    const confirmed = { ...detail.alignment, status: "confirmed" as const };
    const saved = await srv.json<{ alignment: Alignment }>(
      "PUT",
      `/api/projects/${pid}/pairs/${pair.id}/alignment`,
      confirmed,
    );
    expect(saved.alignment.status).toBe("confirmed");

    const broken = { ...confirmed, units: [{ ...confirmed.units[0]!, source: ["nope"] }] };
    expect(
      (await srv.call("PUT", `/api/projects/${pid}/pairs/${pair.id}/alignment`, broken)).status,
    ).toBe(400);

    const reproposed = await srv.json<{ alignment: Alignment }>(
      "POST",
      `/api/projects/${pid}/pairs/${pair.id}/alignment/propose`,
      { source: 1, target: 1 },
    );
    expect(reproposed.alignment.tocDepthSource).toBe(1);
  });

  it("rejects DRM-protected books with a clear message", async () => {
    srv = await makeTestServer();
    const pid = await project(srv);
    const drm = buildFixtureEpub({
      docs: [{ path: "a.xhtml", body: "<p>x</p>" }],
      extraEntries: [{ name: "META-INF/rights.xml", data: new TextEncoder().encode("<r/>") }],
    });
    const res = await srv.call(
      "POST",
      `/api/projects/${pid}/pairs`,
      form(drm, sampleNovelTranslation()),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("DRM");
  });
});
