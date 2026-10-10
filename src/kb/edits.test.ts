import { describe, expect, it } from "vitest";
import type { Edit } from "../prompts/phase2.ts";
import { emptyKb, type Kb, type KbEntry } from "../shared/schemas/kb.ts";
import { type ApplyContext, applyEdits } from "./edits.ts";

function entry(id: string, source: string, extra: Partial<KbEntry> = {}): KbEntry {
  return {
    id,
    kind: "person",
    source,
    aliases: [],
    target: null,
    targetSeen: [],
    treatment: null,
    attributes: [],
    note: "",
    examples: [],
    refs: [],
    status: "auto",
    question: null,
    origin: "phase2",
    updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

const fields = (f: Partial<NonNullable<Edit["fields"]>>): NonNullable<Edit["fields"]> => ({
  kind: null,
  source: null,
  aliases: null,
  target: null,
  treatment: null,
  attributes: null,
  note: null,
  status: null,
  question: null,
  ...f,
});

function kbOf(entries: KbEntry[]): Kb {
  return { ...emptyKb("book", "Test"), entries };
}

const ctx = (ids: Record<string, string>): ApplyContext => ({
  ids: new Map(Object.entries(ids)),
  deleted: new Set(),
  refId: null,
  refText: null,
});

describe("applyEdits", () => {
  it("fills gaps when an entry is added again, without overriding decisions", () => {
    const kb = kbOf([
      entry("b_king", "the young King", {
        target: "młody król",
        attributes: [{ key: "gender", value: "male" }],
      }),
    ]);
    const { kb: out, outcomes } = applyEdits(
      kb,
      [
        {
          op: "add",
          id: null,
          reason: "appears",
          fields: fields({
            kind: "person",
            source: "The Young King",
            target: "Młody Król",
            aliases: ["the King"],
            attributes: [
              { key: "gender", value: "female" },
              { key: "age", value: "sixteen" },
            ],
            note: "the hero",
          }),
        },
      ],
      ctx({ p1: "b_king" }),
    );
    expect(outcomes[0]).toMatchObject({ result: "applied", entryId: "b_king" });
    expect(outcomes[0]!.message).toContain("already listed as p1");
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      target: "młody król",
      aliases: ["the King"],
      attributes: [
        { key: "gender", value: "male" },
        { key: "age", value: "sixteen" },
      ],
      note: "the hero",
    });
  });

  it("keeps a duplicate of a locked entry as a suggestion", () => {
    const kb = kbOf([entry("b_x", "Joyeuse", { status: "locked", target: "Joyeuse" })]);
    const { kb: out, outcomes } = applyEdits(
      kb,
      [
        {
          op: "add",
          id: null,
          reason: "r",
          fields: fields({ kind: "place", source: "Joyeuse", target: "Radosny" }),
        },
      ],
      ctx({ p1: "b_x" }),
    );
    expect(outcomes[0]!.result).toBe("suggestion");
    expect(out.entries[0]!.target).toBe("Joyeuse");
  });

  it("rejects unknown ids and open entries without a question", () => {
    const { outcomes } = applyEdits(
      kbOf([]),
      [
        { op: "update", id: "p9", reason: "r", fields: fields({ target: "x" }) },
        {
          op: "add",
          id: null,
          reason: "r",
          fields: fields({ kind: "person", source: "Hans", status: "open" }),
        },
      ],
      ctx({}),
    );
    expect(outcomes.map((o) => o.result)).toEqual(["rejected", "rejected"]);
  });
});
