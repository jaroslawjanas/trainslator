import { afterEach, describe, expect, it } from "vitest";
import { Kb } from "../shared/schemas/kb.ts";
import { writeJson } from "../store/json.ts";
import { sampleNovel } from "../testing/epub-fixtures.ts";
import { type FakeReply, type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
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

interface Cell {
  text: string | null;
  status: string;
  edited: boolean;
}
interface ReviewUnit {
  key: string;
  urlKey: string;
  source: string;
  versions: Record<string, Cell>;
}

/** Rewrite requests get this answer; translation requests the usual fake translation. */
let rewriteAnswer = "NOWY TEKST";

function prompt(body: Record<string, unknown>): string {
  return (body.messages as { content: string }[]).map((m) => m.content).join("\n");
}

async function setup() {
  rewriteAnswer = "NOWY TEKST";
  fake = await startFakeOpenAI(
    (body): FakeReply =>
      prompt(body).includes("# The passage")
        ? { content: JSON.stringify({ text: rewriteAnswer }) }
        : translateReply(body),
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
  const base = `/api/projects/${project.id}/books/${book.id}`;
  const { job } = await srv.json<{ job: { id: string } }>("POST", `${base}/phase3/run`);
  await srv.ctx.runner.wait(job.id);
  const { id: saved } = await srv.json<{ id: string }>("POST", `${base}/history/translations`);
  const { chapters } = await srv.json<{ chapters: { id: string; title: string }[] }>(
    "GET",
    `${base}/chapters`,
  );
  const chapter = chapters.find((c) => c.title === "Chapter One")!.id;
  return { pid: project.id, bookId: book.id, base, saved, chapter };
}

async function review(base: string, chapter: string, versions: string[]) {
  return (
    await srv!.json<{ units: ReviewUnit[] }>(
      "GET",
      `${base}/chapters/${chapter}/review?versions=${versions.join(",")}`,
    )
  ).units;
}

const keeper = (units: ReviewUnit[]) => units.find((u) => u.source.startsWith("The keeper"))!;

describe("review", () => {
  it("shows versions side by side and edits any of them", async () => {
    const { base, saved, chapter } = await setup();
    let units = await review(base, chapter, ["current", saved]);
    const unit = keeper(units);
    expect(unit.versions.current!.text).toBe(unit.versions[saved]!.text);

    // Your own text in the saved version; the current one is untouched.
    await srv!.json("PUT", `${base}/versions/${saved}/units/${unit.urlKey}`, {
      text: "Kot latarnika nazywał się Pieprz.",
    });
    units = await review(base, chapter, ["current", saved]);
    expect(keeper(units).versions[saved]).toMatchObject({
      text: "Kot latarnika nazywał się Pieprz.",
      edited: true,
    });
    expect(keeper(units).versions.current!.edited).toBe(false);
    // The chapter list counts the passages that differ between the versions.
    const { chapters } = await srv!.json<{
      chapters: { id: string; units: number; different: number | null }[];
    }>("GET", `${base}/review/chapters?versions=current,${saved}`);
    expect(chapters.find((c) => c.id === chapter)).toMatchObject({ different: 1 });
    expect(chapters.filter((c) => c.id !== chapter).every((c) => c.different === 0)).toBe(true);
    const single = await srv!.json<{ chapters: { different: number | null }[] }>(
      "GET",
      `${base}/review/chapters?versions=current`,
    );
    expect(single.chapters.every((c) => c.different === null)).toBe(true);
    // The saved translation now differs from the current one.
    const history = await srv!.json<{ current: { savedAs: string | null } }>(
      "GET",
      `${base}/history`,
    );
    expect(history.current.savedAs).toBeNull();

    // Copy it to the current translation, then go back to the AI's text in the saved one.
    await srv!.json("PUT", `${base}/versions/current/units/${unit.urlKey}`, {
      text: "Kot latarnika nazywał się Pieprz.",
    });
    await srv!.json("DELETE", `${base}/versions/${saved}/units/${unit.urlKey}/edit`);
    units = await review(base, chapter, ["current", saved]);
    expect(keeper(units).versions.current!.text).toBe("Kot latarnika nazywał się Pieprz.");
    expect(keeper(units).versions[saved]!.text).toBe(unit.versions[saved]!.text);

    // Broken formatting tags are refused in a saved version too.
    const withNote = units.find((u) => u.source.includes("<x4/>"))!;
    const refused = await srv!.call("PUT", `${base}/versions/${saved}/units/${withNote.urlKey}`, {
      text: "Bez przypisu.",
    });
    expect(refused.status).toBe(400);
  });

  it("searches one chapter or the whole book, in the versions chosen", async () => {
    const { base, saved, chapter } = await setup();
    type Found = {
      results: { chapterId: string; version: string; match: string; key: string }[];
      total: number;
    };
    const search = (q: string, versions: string[], inChapter?: string) =>
      srv!.json<Found>(
        "GET",
        `${base}/review/search?q=${encodeURIComponent(q)}&versions=${versions.join(",")}${inChapter ? `&chapter=${inChapter}` : ""}`,
      );
    // The English and the (uppercased) fake translation, case ignored.
    const both = await search("keeper", ["source", "current"]);
    expect(new Set(both.results.map((r) => r.version))).toEqual(new Set(["source", "current"]));
    expect(both.results.find((r) => r.version === "current")!.match).toBe("KEEPER");
    expect(both.total).toBe(both.results.length);
    // Only the chosen versions, and only the open chapter when asked.
    const savedOnly = await search("keeper", [saved]);
    expect(savedOnly.results.every((r) => r.version === saved)).toBe(true);
    const all = await search("the", ["source"]);
    const one = await search("the", ["source"], chapter);
    expect(one.results.every((r) => r.chapterId === chapter)).toBe(true);
    expect(one.total).toBeLessThan(all.total);
    expect((await srv!.call("GET", `${base}/review/search?q=&versions=source`)).status).toBe(400);
  });

  it("replaces text in the translations, never the English, and can be undone", async () => {
    const { base, saved, chapter } = await setup();
    const replace = (body: Record<string, unknown>) =>
      srv!.json<{ passages: number; replaced: number; skipped: number }>(
        "POST",
        `${base}/review/replace`,
        { query: "keeper", replacement: "LATARNIK", chapterId: chapter, ...body },
      );
    // Counted first, nothing changed.
    const counted = await replace({ versions: ["source", "current"], dryRun: true });
    expect(counted.passages).toBeGreaterThan(0);
    let unit = keeper(await review(base, chapter, ["current", saved]));
    expect(unit.versions.current!.text).toContain("KEEPER");

    // One passage only, in the current translation; the saved one and the English stay.
    await replace({ versions: ["current"], key: unit.key });
    unit = keeper(await review(base, chapter, ["current", saved]));
    expect(unit.versions.current).toMatchObject({ edited: true });
    expect(unit.versions.current!.text).toContain("LATARNIK");
    expect(unit.versions.current!.text).not.toContain("KEEPER");
    expect(unit.versions[saved]!.text).toContain("KEEPER");
    expect(unit.source).toContain("keeper");

    // Replacing again: the current translation (now unlike any saved one) is saved
    // first, so this replacement can be undone by restoring it.
    await replace({ query: "the", replacement: "TEN", wholeWord: true, versions: ["current"] });
    const history = await srv!.json<{ translations: { reason: string }[] }>(
      "GET",
      `${base}/history`,
    );
    expect(history.translations.map((t) => t.reason)).toEqual(["run", "replace"]);

    // All of the chapter in the saved version.
    const all = await replace({ versions: [saved] });
    expect(all.replaced).toBeGreaterThan(0);
    unit = keeper(await review(base, chapter, ["current", saved]));
    expect(unit.versions[saved]!.text).toContain("LATARNIK");

    // The English alone can't be replaced in.
    const refused = await srv!.call("POST", `${base}/review/replace`, {
      query: "keeper",
      replacement: "x",
      versions: ["source"],
    });
    expect(refused.status).toBe(400);
  });

  it("rewrites a passage, or only a selected part, with or without context and knowledge", async () => {
    const { pid, bookId, base, chapter } = await setup();
    await writeJson(srv!.ctx.paths.bookKb(pid, bookId), Kb, {
      schemaVersion: 1,
      scope: "book",
      title: "Book",
      entries: [
        {
          id: "e1",
          kind: "person",
          source: "Mira",
          aliases: [],
          target: "Mira",
          targetSeen: [],
          treatment: "kept",
          attributes: [],
          note: "",
          examples: [],
          refs: [],
          status: "auto",
          question: null,
          origin: "user",
          updatedAt: new Date().toISOString(),
        },
      ],
      styleRules: [],
    });
    const unit = keeper(await review(base, chapter, ["current"]));
    const text = unit.versions.current!.text!;
    const rewrite = (body: Record<string, unknown>) =>
      srv!.json<{ text: string; warnings: string[] }>(
        "POST",
        `${base}/units/${unit.urlKey}/rewrite`,
        { version: "current", text, modelId: "model1", ...body },
      );

    // The whole passage, without context or knowledge bases.
    const whole = await rewrite({ context: false, knowledgeBases: false, instruction: "shorter" });
    expect(whole.text).toBe("NOWY TEKST");
    let sent = prompt(fake!.requests.at(-1)!);
    expect(sent).toContain("Reviewer's instruction: shorter");
    expect(sent).not.toContain("Mira → Mira");
    expect(sent).not.toContain("# The text around the passage");

    // Only the first word, with context and knowledge bases; the rest stays.
    const first = text.indexOf(" ");
    rewriteAnswer = "KOCUR";
    const part = await rewrite({
      selection: { start: 0, end: first },
      context: true,
      knowledgeBases: true,
    });
    expect(part.text).toBe(`KOCUR${text.slice(first)}`);
    sent = prompt(fake!.requests.at(-1)!);
    expect(sent).toContain(`⟦${text.slice(0, first)}⟧`);
    expect(sent).toContain("Mira → Mira");
    expect(sent).toContain("# The text around the passage");

    // Nothing was saved: a rewrite is only a proposal.
    expect(keeper(await review(base, chapter, ["current"])).versions.current!.text).toBe(text);
  });
});
