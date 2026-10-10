import { afterEach, describe, expect, it } from "vitest";
import { Kb, type KbEntry } from "../shared/schemas/kb.ts";
import { writeJson } from "../store/json.ts";
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

const ANSWER = {
  target: "Pieprz",
  treatment: "translated",
  attributes: [{ key: "gender", value: "male" }],
  note: "The keeper's cat.",
  explanation: "Pepper is a pet's name with a meaning, so it is translated.",
};

function entry(overrides: Partial<KbEntry>): KbEntry {
  return {
    id: "e1",
    kind: "named_thing",
    source: "Pepper",
    aliases: [],
    target: null,
    targetSeen: [],
    treatment: null,
    attributes: [],
    note: "",
    examples: [],
    refs: [],
    status: "open",
    question: "Is Pepper the cat's name, and should it be translated?",
    origin: "phase2",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup() {
  fake = await startFakeOpenAI(() => ({ content: JSON.stringify(ANSWER) }));
  srv = await makeTestServer();
  await srv.json("PUT", "/api/settings/connections/conn1", makeConnection(fake.url));
  await srv.json("PUT", "/api/settings/models/model1", makeModel("openai"));
  await srv.json(
    "PUT",
    "/api/settings/models/strong",
    makeModel("openai", { id: "strong", modelName: "strong-model", label: "Strong" }),
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
  await writeJson(srv.ctx.paths.bookKb(project.id, book.id), Kb, {
    schemaVersion: 1,
    scope: "book",
    title: "Book",
    entries: [
      entry({}),
      entry({
        id: "e2",
        kind: "person",
        source: "Mira",
        target: "Mira",
        status: "auto",
        question: null,
      }),
    ],
    styleRules: [],
  });
  return `/api/projects/${project.id}/books/${book.id}/kb/entries`;
}

describe("asking a model about an open question", () => {
  it("returns the model's proposal without saving it", async () => {
    const base = await setup();
    const answer = await srv!.json<typeof ANSWER>("POST", `${base}/e1/ask`, {
      modelId: "strong",
    });
    expect(answer).toEqual(ANSWER);
    const sent = fake!.requests[0]!;
    expect(sent.model).toBe("strong-model");
    const prompt = JSON.stringify(sent.messages);
    expect(prompt).toContain("Is Pepper the cat's name");
    // The rest of the knowledge base goes with it.
    expect(prompt).toContain("Mira → Mira");
    // Nothing changed: the question is still open.
    const { kb } = await srv!.json<{ kb: { entries: KbEntry[] } }>(
      "GET",
      base.replace(/\/entries$/, ""),
    );
    expect(kb.entries.find((e) => e.id === "e1")!.status).toBe("open");
  });

  it("refuses entries without an open question", async () => {
    const base = await setup();
    const res = await srv!.call("POST", `${base}/e2/ask`, { modelId: "model1" });
    expect(res.status).toBe(400);
  });
});
