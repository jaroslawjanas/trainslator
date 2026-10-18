import { afterEach, describe, expect, it } from "vitest";
import { Glossary, type GlossaryTerm } from "../shared/schemas/translation.ts";
import { writeJson } from "../store/json.ts";
import { sampleNovel } from "../testing/epub-fixtures.ts";
import { makeTestServer, type TestServer } from "../testing/server.ts";

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.cleanup();
  srv = null;
});

type Term = GlossaryTerm & { inKb: { id: string; target: string | null } | null };

function term(source: string, target: string, patch: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return { kind: "person", source, target, note: "", chunkIndex: 0, conflict: null, ...patch };
}

const newEntry = (source: string, target: string) => ({
  kind: "person",
  source,
  aliases: [],
  target,
  targetSeen: [],
  treatment: "translated",
  attributes: [],
  note: "",
  examples: [],
  status: "locked",
  question: null,
});

async function setup(terms: GlossaryTerm[]) {
  srv = await makeTestServer();
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
  await writeJson(srv.ctx.paths.phase3Glossary(project.id, book.id), Glossary, {
    schemaVersion: 1,
    terms,
  });
  return `/api/projects/${project.id}/books/${book.id}`;
}

describe("coined terms", () => {
  it("can be edited, deleted and moved to the knowledge base", async () => {
    const base = await setup([
      term("Brannock", "Brannok", { conflict: 'chunk 4 used "Branok"' }),
      term("lamp-oil", "nafta", { kind: "term" }),
      term("Tobias", "Tobiasz"),
    ]);
    const list = await srv!.json<{ terms: Term[] }>("GET", `${base}/glossary`);
    expect(list.terms.map((t) => [t.source, t.inKb])).toEqual([
      ["Brannock", null],
      ["lamp-oil", null],
      ["Tobias", null],
    ]);

    // Your edit is used from then on and settles the conflict.
    const edited = await srv!.json<{ terms: Term[] }>("PUT", `${base}/glossary/0`, {
      source: "Brannock",
      term: { kind: "place", source: "Brannock", target: "Branok", note: "The lighthouse." },
    });
    expect(edited.terms[0]).toMatchObject({
      kind: "place",
      target: "Branok",
      note: "The lighthouse.",
      conflict: null,
    });

    // A list that changed in the meantime, or a name another term has, is refused.
    const stale = await srv!.call("PUT", `${base}/glossary/1`, {
      source: "Brannock",
      term: { kind: "term", source: "lamp-oil", target: "olej", note: "" },
    });
    expect(stale.status).toBe(400);
    const duplicate = await srv!.call("PUT", `${base}/glossary/1`, {
      source: "lamp-oil",
      term: { kind: "term", source: "brannock", target: "olej", note: "" },
    });
    expect(duplicate.status).toBe(400);

    // Moving adds your entry to the book's knowledge base and takes the term off the list.
    const moved = await srv!.json<{
      kb: { entries: { source: string; target: string; status: string; origin: string }[] };
      terms: Term[];
    }>("POST", `${base}/glossary/2/move`, {
      source: "Tobias",
      entry: newEntry("Tobias", "Tobiasz"),
    });
    expect(moved.kb.entries).toEqual([
      expect.objectContaining({
        source: "Tobias",
        target: "Tobiasz",
        status: "locked",
        origin: "user",
      }),
    ]);
    expect(moved.terms.map((t) => t.source)).toEqual(["Brannock", "lamp-oil"]);

    const deleted = await srv!.json<{ terms: Term[] }>(
      "DELETE",
      `${base}/glossary/1?source=${encodeURIComponent("lamp-oil")}`,
    );
    expect(deleted.terms.map((t) => t.source)).toEqual(["Brannock"]);

    // A term the knowledge base already has says so.
    await srv!.json("POST", `${base}/kb/entries`, newEntry("Brannock", "Branok"));
    const after = await srv!.json<{ terms: Term[] }>("GET", `${base}/glossary`);
    expect(after.terms[0]?.inKb).toMatchObject({ target: "Branok" });
  });
});
