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
