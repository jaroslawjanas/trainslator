import { afterEach, describe, expect, it } from "vitest";
import { EpubBook } from "../epub/book.ts";
import type { Alignment } from "../shared/schemas/alignment.ts";
import type { BookSetup, EpubStructure } from "../shared/schemas/epub.ts";
import type { Kb } from "../shared/schemas/kb.ts";
import {
  buildFixtureEpub,
  sampleGermanNovel,
  sampleNovel,
  sampleNovelTranslation,
  sampleRussianNovel,
} from "../testing/epub-fixtures.ts";
import { type FakeHandler, type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
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

function text(body: Record<string, unknown>): string {
  return JSON.stringify(body.messages);
}

async function project(handler: FakeHandler, sourceLang: string, targetLang: string) {
  fake = await startFakeOpenAI(handler);
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
    sourceLang,
    targetLang,
  });
  return project.id;
}

async function addBook(pid: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set("file", new File([bytes], "book.epub"));
  const { book } = await srv!.json<{ book: { id: string } }>(
    "POST",
    `/api/projects/${pid}/books`,
    form,
  );
  return book.id;
}

/** Phase 2 reads the body chapters. */
async function readBodyChapters(base: string) {
  const detail = await srv!.json<{ structure: EpubStructure; setup: BookSetup }>("GET", base);
  const body = detail.structure.segmentsByDepth["1"]!.filter((s) => s.guess === "body");
  await srv!.json("PUT", `${base}/setup`, {
    ...detail.setup,
    tocDepth: 1,
    phase2Segments: body.map((s) => s.id),
  });
}

async function runJob(path: string, body?: unknown) {
  const { job } = await srv!.json<{ job: { id: string } }>("POST", path, body);
  const done = await srv!.ctx.runner.wait(job.id);
  expect(done?.error ?? null).toBeNull();
  return done!;
}

interface UnitView {
  source: string;
  translation: string | null;
  warnings: string[];
}

async function chapterUnits(base: string, title: string): Promise<UnitView[]> {
  const { chapters } = await srv!.json<{ chapters: { id: string; title: string }[] }>(
    "GET",
    `${base}/chapters`,
  );
  const chapter = chapters.find((c) => c.title === title)!;
  return (await srv!.json<{ units: UnitView[] }>("GET", `${base}/chapters/${chapter.id}/units`))
    .units;
}

async function builtLanguages(base: string): Promise<string[]> {
  await runJob(`${base}/build`, { useBestAttempts: true });
  const bytes = await srv!.call("GET", `${base}/output`);
  return EpubBook.open(new Uint8Array(await bytes.arrayBuffer())).pkg.languages;
}

/** A Polish book that names the pair's ship and cat only in inflected forms. */
function polishBook(): Uint8Array {
  return buildFixtureEpub({
    language: "pl",
    title: "Powrót",
    docs: [
      {
        path: "text/r1.xhtml",
        title: "Rozdział pierwszy",
        body: `<h1>Rozdział pierwszy</h1>
<p>Statek Szarej Czapli wpłynął do portu o świcie.</p>
<p>Mira dała Pieprzowi miskę mleka i usiadła przy oknie.</p>
<p>Nie wiedziała jeszcze, że to był ostatni spokojny dzień, ale czuła, że coś się zmieni.</p>`,
      },
    ],
    toc: [{ title: "Rozdział pierwszy", href: "text/r1.xhtml" }],
  });
}

const LEFT_IN_POLISH = "Nie wiedziała jeszcze";

describe("a Polish source", () => {
  it("learns from a Polish→English pair and finds its names in inflected forms", async () => {
    const asked: string[] = [];
    const pid = await project(
      (body) => {
        const t = text(body);
        if (t.includes("You study how a professional translator")) {
          asked.push(t);
          const finding = (source: string, target: string, kind = "named_thing") => ({
            kind,
            source,
            target,
            targetSeen: [],
            treatment: source === target ? "kept" : "translated",
            attributes: [],
            note: "",
            sourceQuote: source,
            targetQuote: target,
          });
          const findings = t.includes("Szara Czapla")
            ? [
                finding("Mira", "Mira", "person"),
                finding("Szara Czapla", "Gray Heron"),
                finding("Poranny Dzwon", "Morning Bell"),
                finding("Pieprz", "Pepper", "person"),
              ]
            : [];
          return { content: JSON.stringify({ findings, styleNotes: [] }) };
        }
        if (t.includes("You turn notes about a published")) {
          const batch = t.slice(t.indexOf("# Decide these groups"));
          const ids = [...batch.matchAll(/(?:^|\\n)(g\d+) \[/g)].map((m) => m[1]);
          const decisions = ids.map((group) => ({
            group,
            action: "entry",
            into: null,
            reason: null,
            entry: null,
          }));
          return { content: JSON.stringify({ decisions }) };
        }
        if (t.includes("You summarize the conventions"))
          return { content: JSON.stringify({ rules: [] }) };
        return translateReply(body, (_id, s) =>
          s.startsWith(LEFT_IN_POLISH)
            ? s.replace(LEFT_IN_POLISH, "She did not know")
            : "An English sentence.",
        );
      },
      "pl",
      "en",
    );

    const form = new FormData();
    form.set("source", new File([sampleNovelTranslation()], "latarniczka.epub"));
    form.set("target", new File([sampleNovel()], "keeper.epub"));
    const { pair } = await srv!.json<{ pair: { id: string } }>(
      "POST",
      `/api/projects/${pid}/pairs`,
      form,
    );
    const { alignment } = await srv!.json<{ alignment: Alignment }>(
      "GET",
      `/api/projects/${pid}/pairs/${pair.id}`,
    );
    await srv!.json("PUT", `/api/projects/${pid}/pairs/${pair.id}/alignment`, {
      ...alignment,
      status: "confirmed",
      units: alignment.units.map((u) => ({
        ...u,
        include: u.source.length > 0 && u.target.length > 0,
      })),
    });
    await runJob(`/api/projects/${pid}/pairs/${pair.id}/phase1/run`);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]).toContain("rendered a Polish novel into English");
    expect(asked[0]).toContain("in their Polish base form");
    const { kb } = await srv!.json<{ kb: Kb }>("GET", `/api/projects/${pid}/pairs/${pair.id}/kb`);
    expect(kb.entries.map((e) => e.source).sort()).toEqual([
      "Mira",
      "Pieprz",
      "Poranny Dzwon",
      "Szara Czapla",
    ]);

    // The new book mentions three of the four only as "Szarej Czapli", "Pieprzowi", "Mira".
    const bookId = await addBook(pid, polishBook());
    const base = `/api/projects/${pid}/books/${bookId}`;
    await srv!.json("PATCH", base, { refKbMode: "relevant" });
    const detail = await srv!.json<{ reference: { entries: number; totalEntries: number } }>(
      "GET",
      base,
    );
    expect(detail.reference).toMatchObject({ entries: 3, totalEntries: 4 });

    // Translated into English; the passage left in Polish is pointed out.
    await readBodyChapters(base);
    await runJob(`${base}/phase2/run`);
    await runJob(`${base}/phase3/run`);
    const units = await chapterUnits(base, "Rozdział pierwszy");
    const left = units.find((u) => u.source.startsWith(LEFT_IN_POLISH))!;
    expect(left.warnings).toContain("may still be partly in Polish");
    expect(units.filter((u) => u !== left).flatMap((u) => u.warnings)).not.toContain(
      "may still be partly in Polish",
    );
    expect(await builtLanguages(base)).toEqual(["en"]);
  });
});

/** A knowledge base edit that adds an entry, as phase 2 returns it. */
function add(kind: string, source: string, target: string) {
  return {
    op: "add",
    id: null,
    reason: "named in the chapter",
    fields: {
      kind,
      source,
      aliases: null,
      target,
      treatment: "translated",
      attributes: null,
      note: null,
      status: null,
      question: null,
    },
  };
}

describe("a German source", () => {
  it("guesses German front and back matter, keeps names in base form and finds them inflected", async () => {
    const asked: string[] = [];
    const pid = await project(
      (body) => {
        const t = text(body);
        if (t.includes("You review a knowledge base"))
          return { content: JSON.stringify({ edits: [] }) };
        if (t.includes("You prepare a knowledge base")) {
          asked.push(t);
          const chapter = t.slice(t.lastIndexOf("# Chapter:"));
          const edits = chapter.includes("Erstes Kapitel")
            ? [
                add("organization", "Orden", "Zakon"),
                add("place", "Schwarzer Turm", "Czarna Wieża"),
                add("person", "Anna", "Anna"),
                add("person", "Kapitän", "Kapitan"),
              ]
            : // Listed already: the captain with an article, the order (only "des Ordens" here).
              [add("person", "der Kapitän", "Kapitan"), add("organization", "Orden", "Zakon")];
          return { content: JSON.stringify({ synopsis: "Anna waits at the tower.", edits }) };
        }
        return translateReply(body);
      },
      "de",
      "pl",
    );

    const bookId = await addBook(pid, sampleGermanNovel());
    const base = `/api/projects/${pid}/books/${bookId}`;
    const { structure } = await srv!.json<{ structure: EpubStructure }>("GET", base);
    const guesses = Object.fromEntries(
      structure.segmentsByDepth["1"]!.map((s) => [s.title, s.guess]),
    );
    expect(guesses).toEqual({
      Inhaltsverzeichnis: "front",
      "Erstes Kapitel": "body",
      "Zweites Kapitel": "body",
      Danksagung: "back",
    });

    await readBodyChapters(base);
    await runJob(`${base}/phase2/run`);
    expect(asked[0]).toContain("translating a German novel into Polish");
    expect(asked[0]).toContain("in their German base form");
    const { kb } = await srv!.json<{ kb: Kb }>("GET", `${base}/kb`);
    expect(kb.entries.map((e) => e.source).sort()).toEqual([
      "Anna",
      "Kapitän",
      "Orden",
      "Schwarzer Turm",
    ]);
    // Entries a chapter names get that chapter as a ref, inflected forms included.
    const refs = Object.fromEntries(kb.entries.map((e) => [e.source, e.refs.length]));
    expect(refs).toEqual({ Orden: 2, Kapitän: 2, "Schwarzer Turm": 1, Anna: 1 });

    await runJob(`${base}/phase3/run`);
    expect(await builtLanguages(base)).toEqual(["pl"]);
  });
});

describe("a Russian source", () => {
  it("guesses Russian front and back matter and finds names in Cyrillic case forms", async () => {
    const asked: string[] = [];
    const pid = await project(
      (body) => {
        const t = text(body);
        if (t.includes("You review a knowledge base"))
          return { content: JSON.stringify({ edits: [] }) };
        if (t.includes("You prepare a knowledge base")) {
          asked.push(t);
          const chapter = t.slice(t.lastIndexOf("# Chapter:"));
          const edits = chapter.includes("Глава первая")
            ? [
                add("organization", "Орден", "Zakon"),
                add("place", "Чёрная башня", "Czarna Wieża"),
                add("person", "Анна", "Anna"),
                add("person", "Капитан", "Kapitan"),
              ]
            : // Listed already; the order is only "Ордена" here.
              [add("person", "Капитан", "Kapitan"), add("organization", "Орден", "Zakon")];
          return { content: JSON.stringify({ synopsis: "Anna waits at the tower.", edits }) };
        }
        return translateReply(body);
      },
      "ru",
      "pl",
    );

    const bookId = await addBook(pid, sampleRussianNovel());
    const base = `/api/projects/${pid}/books/${bookId}`;
    const { structure } = await srv!.json<{ structure: EpubStructure }>("GET", base);
    const guesses = Object.fromEntries(
      structure.segmentsByDepth["1"]!.map((s) => [s.title, s.guess]),
    );
    expect(guesses).toEqual({
      Содержание: "front",
      "Глава первая": "body",
      "Глава вторая": "body",
      Благодарности: "back",
    });

    await readBodyChapters(base);
    await runJob(`${base}/phase2/run`);
    expect(asked[0]).toContain("translating a Russian novel into Polish");
    expect(asked[0]).toContain("in their Russian base form");
    const { kb } = await srv!.json<{ kb: Kb }>("GET", `${base}/kb`);
    expect(kb.entries.map((e) => e.source).sort()).toEqual([
      "Анна",
      "Капитан",
      "Орден",
      "Чёрная башня",
    ]);
    // "Чёрная башня" is only in the text as "Чёрной башни" and "Чёрной башне".
    const refs = Object.fromEntries(kb.entries.map((e) => [e.source, e.refs.length]));
    expect(refs).toEqual({ Орден: 2, Капитан: 2, "Чёрная башня": 1, Анна: 1 });

    await runJob(`${base}/phase3/run`);
    expect(await builtLanguages(base)).toEqual(["pl"]);
  });
});
