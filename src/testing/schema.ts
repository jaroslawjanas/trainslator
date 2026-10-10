import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";
import type { z } from "zod";
import { checkStrictSchema, type JsonSchema, toStrictJsonSchema } from "../llm/structured.ts";

/** Builds a value that should validate: `nulls` puts null wherever null is allowed. */
export function sampleFromSchema(node: JsonSchema, nulls: boolean): unknown {
  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf as JsonSchema[];
    const nullBranch = branches.find((b) => b.type === "null");
    if (nulls && nullBranch) return null;
    const other = branches.find((b) => b.type !== "null") ?? branches[0]!;
    return sampleFromSchema(other, nulls);
  }
  if (Array.isArray(node.enum)) return node.enum[0];
  switch (node.type) {
    case "object": {
      const props = (node.properties ?? {}) as Record<string, JsonSchema>;
      return Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, sampleFromSchema(v, nulls)]),
      );
    }
    case "array":
      return [sampleFromSchema(node.items as JsonSchema, nulls)];
    case "string":
      return "text";
    case "integer":
      return 1;
    case "number":
      return 1.5;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      throw new Error(`Unexpected node ${JSON.stringify(node)}`);
  }
}

/** Checks that a zod output schema converts to strict mode and round-trips through Ajv. */
export function expectStrictRoundTrip(schema: z.ZodType): void {
  const json = toStrictJsonSchema(schema);
  expect(checkStrictSchema(json)).toEqual([]);
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(json);
  for (const nulls of [false, true]) {
    const sample = sampleFromSchema(json, nulls);
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    // The zod schema must accept whatever the JSON Schema allows.
    const parsed = schema.safeParse(sample);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
  }
}
