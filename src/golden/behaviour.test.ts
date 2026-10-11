import { describe, expect, it } from "vitest";
import { extractDocUnits } from "../epub/blocks.ts";
import { EpubBook } from "../epub/book.ts";
import { buildSegments } from "../epub/segments.ts";
import { assembleKb, resolveDecisions } from "../kb/assemble.ts";
import { applyEdits } from "../kb/edits.ts";
import { groupDetail, groupFindings, groupIndexLine, groupStyleNotes } from "../kb/group.ts";
import { promptIds, renderKb } from "../kb/render.ts";
import { selectReferenceKbs } from "../kb/select.ts";
import { proposeAlignment } from "../pipeline/alignment.ts";
import { checkUnitTranslation } from "../pipeline/validate.ts";
import type { Finding, MergeDecision } from "../prompts/phase1.ts";
import type { Edit } from "../prompts/phase2.ts";
import { emptyOverrides } from "../shared/schemas/kb.ts";
import { buildFixtureEpub, sampleNovel, sampleNovelTranslation } from "../testing/epub-fixtures.ts";

/**
 * How English books and knowledge bases are handled today: name keys,
 * grouping, refs, the reference selection, front/back-matter guesses,
 * alignment and the translation checks. Adding other source languages must
 * leave all of this exactly as it is.
 */

const golden = (name: string) => `./__golden__/en/${name}.txt`;

function finding(source: string, target: string, extra: Partial<Finding> = {}): Finding {
  return {
    kind: "person",
    source,
    target,
    targetSeen: [],
    treatment: "translated",
    attributes: [],
    note: "",
    sourceQuote: `${source} came`,
    targetQuote: `${target} przyszedł`,
    ...extra,
  };
}

const UNITS = [
  {
    unitId: "a0",
    findings: [
      finding("The storm", "sztorm", { kind: "term" }),
      finding("a Ship", "statek", { kind: "named_thing" }),
      finding("Mira", "Mira", {
        treatment: "kept",
        attributes: [{ key: "gender", value: "female" }],
      }),
      finding("the Gray Heron", "Szara Czapla", { kind: "named_thing" }),
    ],
    styleNotes: [{ rule: "The dialogue uses dashes.", sourceQuote: "a", targetQuote: "b" }],
  },
  {
    unitId: "a1",
    findings: [
      finding("storm", "burza", { kind: "term" }),
      finding("Gray Heron", "Szara Czapla", { kind: "named_thing" }),
      finding("An Owl", "Sowa", { kind: "named_thing" }),
    ],
    styleNotes: [{ rule: "the dialogue uses dashes", sourceQuote: "c", targetQuote: "d" }],
  },
];

describe("English behaviour stays the same", () => {
  it("groups findings by name key", async () => {
    const groups = groupFindings(UNITS, "en");
    const text = [
      ...groups.map(groupIndexLine),
      "",
      ...groups.map(groupDetail),
      "",
      ...groupStyleNotes(UNITS).map((s) => JSON.stringify(s)),
    ].join("\n");
    await expect(`${text}\n`).toMatchFileSnapshot(golden("kb-groups"));
  });

  it("assembles, renders, finds refs and selects reference entries", async () => {
    const groups = groupFindings(UNITS, "en");
    const decisions = new Map<string, MergeDecision>(
      groups.map((g) => [
        g.id,
        { group: g.id, action: "entry", into: null, reason: null, entry: null },
      ]),
    );
    const kb = assembleKb({
      scope: "pair",
      title: "Earlier Book",
      resolution: resolveDecisions(groups, decisions, new Map()),
      style: {
        rules: [{ rule: "Dialogue uses dashes.", sourceExample: null, targetExample: null }],
      },
      existing: null,
      overrides: emptyOverrides(),
      lang: "en",
    });
    const edits: Edit[] = [
      {
        op: "add",
        id: null,
        reason: "new",
        fields: {
          kind: "person",
          source: "Pepper",
          aliases: ["the Cat"],
          target: "Pieprz",
          treatment: "translated",
          attributes: null,
          note: null,
          status: null,
          question: null,
        },
      },
      {
        op: "add",
        id: null,
        reason: "already there",
        fields: {
          kind: "named_thing",
          source: "The Gray Heron",
          aliases: null,
          target: null,
          treatment: null,
          attributes: null,
          note: "a ship",
          status: null,
          question: null,
        },
      },
    ];
    const applied = applyEdits(kb, edits, {
      ids: promptIds(kb),
      deleted: new Set(),
      refId: "s7",
      refText: "Pepper's bowl was empty. The Gray Heron sailed; the cat slept. Grayheron.",
      lang: "en",
    });
    const selection = selectReferenceKbs(
      [{ title: "Earlier Book", kb: applied.kb }],
      "Mira saw the gray heron and a storm. Pepper slept.",
      "relevant",
      1_000_000,
      "en",
    );
    const text = [
      renderKb(applied.kb, { ids: promptIds(applied.kb), markLocked: true }),
      "",
      ...applied.kb.entries.map((e) => `${e.source}: refs ${JSON.stringify(e.refs)}`),
      "",
      ...applied.outcomes.map((o) => `${o.edit.op} ${o.result}: ${o.message}`),
      "",
      `relevant ${selection.entries}/${selection.totalEntries}`,
      selection.text ?? "(none)",
    ].join("\n");
    await expect(`${text}\n`).toMatchFileSnapshot(golden("kb-assemble"));
  });

  it("guesses front and back matter", async () => {
    const para = (n: number) => `<p>${Array.from({ length: n }, () => "word").join(" ")}.</p>`;
    const titles = [
      ["Cover", 20],
      ["Half-Title", 10],
      ["Title Page", 20],
      ["Copyright", 80],
      ["Dedication", 15],
      ["Epigraph", 30],
      ["Praise for the Author", 200],
      ["Table of Contents", 60],
      ["Chapter 1", 1500],
      ["The Notes of Mr. Hale", 120],
      ["Chapter 2", 1500],
      ["Acknowledgements", 150],
      ["Acknowledgments", 150],
      ["About the Authors", 120],
      ["Also by Jane Doe", 40],
      ["Endnotes", 300],
      ["End Notes", 300],
      ["Glossary", 200],
      ["Index", 400],
      ["Bibliography", 300],
      ["Credits", 50],
      ["Newsletter", 30],
      ["Sneak Peek", 900],
      ["Excerpt", 900],
      ["Reading Group Guide", 400],
      ["Discussion Questions", 300],
      ["About the Type", 60],
      ["About the Publisher", 60],
      ["Imprint", 30],
      ["Colophon", 30],
      ["Frontispiece", 5],
      ["Series Page", 20],
      ["Licence", 500],
      ["License", 500],
    ] as const;
    const docs = titles.map(([title, words], i) => ({
      path: `text/d${i}.xhtml`,
      title,
      body: `<h1>${title}</h1>${para(words)}`,
    }));
    const synthetic = EpubBook.open(
      buildFixtureEpub({ docs, toc: docs.map((d) => ({ title: d.title, href: d.path })) }),
    );
    const lines: string[] = [];
    for (const [name, book] of [
      ["sample novel", EpubBook.open(sampleNovel())],
      ["synthetic", synthetic],
    ] as const) {
      const { segmentsByDepth } = buildSegments(book, "en");
      for (const [depth, segs] of Object.entries(segmentsByDepth))
        for (const s of segs) lines.push(`${name} d${depth} ${s.guess} ${s.words} ${s.title}`);
    }
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(golden("segment-guesses"));
  });

  it("proposes an alignment", async () => {
    const source = buildSegments(EpubBook.open(sampleNovel()), "en").segmentsByDepth["1"]!;
    const target = buildSegments(EpubBook.open(sampleNovelTranslation()), "en").segmentsByDepth[
      "1"
    ]!;
    const alignment = proposeAlignment(source, target, { source: 1, target: 1 });
    const lines = alignment.units.map(
      (u) =>
        `${u.source.join("+") || "-"} | ${u.target.join("+") || "-"} | ${u.include} | ${u.confidence}`,
    );
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(golden("alignment-proposal"));
  });

  it("checks translations", async () => {
    const book = EpubBook.open(
      buildFixtureEpub({
        docs: [
          {
            path: "t.xhtml",
            body: [
              "<p>Mira climbed the hundred steps of the lighthouse every evening, counting them.</p>",
              '<p>She kept a <i>small</i> notebook.<a epub:type="noteref" href="n.xhtml#1">1</a></p>',
              "<p>Sure, I'll come with you tomorrow morning if the weather is good.</p>",
              "<p>“Come in,” said the keeper, and the door creaked open.</p>",
            ].join("\n"),
          },
        ],
      }),
    );
    const units = extractDocUnits(book, 0).filter((u) => u.role !== "title");
    const ctx = { targetScripts: ["Latn"], ratio: 1 };
    const cases: [number, string][] = [
      [0, "Mira co wieczór wspinała się po stu stopniach latarni, licząc je."],
      [0, "Mira climbed the hundred steps of the lighthouse every evening, counting them."],
      [0, "Here is the translation: Mira co wieczór wspinała się po stu stopniach latarni."],
      [0, "Mira **co wieczór** wspinała się po stu stopniach latarni, licząc je."],
      [0, "Mira."],
      [1, "Prowadziła <g1>mały</g1> notes."],
      [1, "Prowadziła <g1>mały</g1> notes.<x2/>"],
      [2, "Sure, I'll come with you tomorrow morning if the weather is good."],
      [2, "Jasne, pójdę z tobą jutro rano, jeśli będzie ładna pogoda."],
      [3, "– Proszę wejść – powiedział latarnik i drzwi otworzyły się ze skrzypnięciem."],
      [3, "“– Proszę wejść – powiedział latarnik.”"],
    ];
    const lines = cases.map(([i, text]) => {
      const r = checkUnitTranslation(units[i]!, text, ctx);
      return `${i} ${JSON.stringify(text)}\n  errors ${JSON.stringify(r.errors)}\n  warnings ${JSON.stringify(r.warnings)}`;
    });
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(golden("translation-checks"));
  });
});
