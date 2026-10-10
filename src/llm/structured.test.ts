import { describe, expect, it } from "vitest";
import { z } from "zod";
import { expectStrictRoundTrip } from "../testing/schema.ts";
import {
  describeSchema,
  fillMissingNulls,
  type JsonSchema,
  toStrictJsonSchema,
} from "./structured.ts";

describe("toStrictJsonSchema", () => {
  const Edit = z.object({
    op: z.enum(["add", "update"]),
    id: z.string().nullable(),
    count: z.number().int().min(0),
    tags: z.array(z.object({ key: z.string(), value: z.string() })),
    kind: z.enum(["a", "b"]).nullable(),
  });
  const Output = z.object({ edits: z.array(Edit), note: z.string().nullable() });

  it("produces a strict schema that round-trips", () => {
    expectStrictRoundTrip(Output);
  });

  it("strips bounds and normalizes nullable types to anyOf", () => {
    const json = toStrictJsonSchema(Output);
    const edit = ((json.properties as JsonSchema).edits as JsonSchema).items as JsonSchema;
    const props = edit.properties as Record<string, JsonSchema>;
    expect(props.count).toEqual({ type: "integer" });
    expect(props.id).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("rejects optional fields, records and literals", () => {
    expect(() => toStrictJsonSchema(z.object({ a: z.string().optional() }))).toThrow(/required/);
    expect(() => toStrictJsonSchema(z.object({ a: z.record(z.string(), z.string()) }))).toThrow();
    expect(() => toStrictJsonSchema(z.object({ a: z.literal("x") }))).toThrow(/const/);
  });

  it("describes a schema compactly", () => {
    const text = describeSchema(toStrictJsonSchema(Output));
    expect(text).toContain('"edits": [');
    expect(text).toContain('"add" | "update"');
  });
});

describe("fillMissingNulls", () => {
  const schema = z.object({
    edits: z.array(
      z.object({
        op: z.enum(["add", "update"]),
        id: z.string().nullable(),
        fields: z.object({ target: z.string().nullable(), note: z.string() }).nullable(),
      }),
    ),
  });
  const json = toStrictJsonSchema(schema);

  it("adds null for left-out nullable keys, at any depth", () => {
    const filled = fillMissingNulls({ edits: [{ op: "add", fields: { note: "x" } }] }, json);
    expect(filled).toEqual({
      edits: [{ op: "add", id: null, fields: { target: null, note: "x" } }],
    });
    expect(schema.safeParse(filled).success).toBe(true);
  });

  it("leaves required non-null keys missing, so validation still catches them", () => {
    const filled = fillMissingNulls({ edits: [{ id: "p1", fields: null }] }, json);
    expect(filled).toEqual({ edits: [{ id: "p1", fields: null }] });
    expect(schema.safeParse(filled).success).toBe(false);
  });
});
