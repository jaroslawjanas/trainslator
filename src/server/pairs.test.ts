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

    const first = detail.alignment.units.find((u) => u.source.length > 0 && u.target.length > 0)!;
    const text = await srv.json<{
      source: { titles: string[]; passages: number };
      target: { titles: string[]; passages: number };
      rows: { source: { role: string; text: string }[]; target: { text: string }[] }[];
    }>(
      "GET",
      `/api/projects/${pid}/pairs/${pair.id}/text?source=${first.source.join(",")}&target=${first.target.join(",")}`,
    );
    expect(text.source.passages).toBeGreaterThan(0);
    expect(text.target.passages).toBeGreaterThan(0);
    expect(text.rows.flatMap((r) => r.source)).toHaveLength(text.source.passages);
    expect(text.rows.flatMap((r) => r.target)).toHaveLength(text.target.passages);
    // Inline formatting comes as Review's tags: "<i>Gray Heron</i>" becomes <g1>…</g1>.
    expect(JSON.stringify(text.rows)).toMatch(/<g\d+>Szara Czapla<\/g\d+>/);
    expect(
      (await srv.call("GET", `/api/projects/${pid}/pairs/${pair.id}/text?source=nope`)).status,
    ).toBe(400);

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

  it("replaces one of the books and proposes the alignment again", async () => {
    srv = await makeTestServer();
    const pid = await project(srv);
    const { pair } = await srv.json<{ pair: { id: string } }>(
      "POST",
      `/api/projects/${pid}/pairs`,
      form(sampleNovel(), sampleNovelTranslation()),
    );
    const before = await srv.json<{ alignment: Alignment }>(
      "GET",
      `/api/projects/${pid}/pairs/${pair.id}`,
    );
    await srv.json("PUT", `/api/projects/${pid}/pairs/${pair.id}/alignment`, {
      ...before.alignment,
      status: "confirmed",
    });

    const replacement = new FormData();
    replacement.set(
      "file",
      new File([sampleNovel("2.0")], "novel-fixed.epub", { type: "application/epub+zip" }),
    );
    const { pair: replaced } = await srv.json<{
      pair: { title: string; sourceFileName: string; filesChangedAt: string | null };
    }>("POST", `/api/projects/${pid}/pairs/${pair.id}/files/source`, replacement);
    expect(replaced.sourceFileName).toBe("novel-fixed.epub");
    expect(replaced.title).toBe("The Lantern Keeper");
    expect(replaced.filesChangedAt).not.toBeNull();
    const after = await srv.json<{ alignment: Alignment }>(
      "GET",
      `/api/projects/${pid}/pairs/${pair.id}`,
    );
    expect(after.alignment.status).toBe("proposed");

    const empty = new FormData();
    empty.set(
      "file",
      new File([buildFixtureEpub({ docs: [{ path: "a.xhtml", body: "<p></p>" }] })], "empty.epub", {
        type: "application/epub+zip",
      }),
    );
    const res = await srv.call("POST", `/api/projects/${pid}/pairs/${pair.id}/files/target`, empty);
    expect(res.status).toBe(400);
    const unchanged = await srv.json<{ pair: { targetFileName: string } }>(
      "GET",
      `/api/projects/${pid}/pairs/${pair.id}`,
    );
    expect(unchanged.pair.targetFileName).toBe("powiesc.epub");
    expect(
      (await srv.call("POST", `/api/projects/${pid}/pairs/${pair.id}/files/cover`, empty)).status,
    ).toBe(404);
  });

  it("counts what the lists show about books and pairs", async () => {
    srv = await makeTestServer();
    const pid = await project(srv);
    const { pair } = await srv.json<{ pair: { id: string } }>(
      "POST",
      `/api/projects/${pid}/pairs`,
      form(sampleNovel(), sampleNovelTranslation()),
    );
    const upload = new FormData();
    upload.set("file", new File([sampleNovel()], "novel.epub", { type: "application/epub+zip" }));
    const { book } = await srv.json<{ book: { id: string } }>(
      "POST",
      `/api/projects/${pid}/books`,
      upload,
    );
    interface Overview {
      books: Record<string, { entries: number; openQuestions: number; passages: number }>;
      pairs: Record<string, { entries: number; styleRules: number }>;
    }
    // Nothing has run: every count is zero, and nothing is missing.
    const empty = await srv.json<Overview>("GET", `/api/projects/${pid}/overview`);
    expect(empty.books[book.id]).toEqual({
      entries: 0,
      openQuestions: 0,
      passages: 0,
      attention: 0,
      pending: 0,
      buildCurrent: null,
    });
    expect(empty.pairs[pair.id]).toEqual({ entries: 0, styleRules: 0 });

    await srv.json("POST", `/api/projects/${pid}/books/${book.id}/kb/entries`, {
      kind: "person",
      source: "Mira",
      aliases: [],
      target: "Mira",
      targetSeen: [],
      treatment: "kept",
      attributes: [],
      note: "",
      examples: [],
      status: "locked",
      question: null,
    });
    // Counted from the files, so an edit shows at once. For one book, pairs are left out.
    const one = await srv.json<Overview>("GET", `/api/projects/${pid}/overview?book=${book.id}`);
    expect(one.books[book.id]?.entries).toBe(1);
    expect(one.books[book.id]?.openQuestions).toBe(0);
    expect(one.pairs).toEqual({});
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
