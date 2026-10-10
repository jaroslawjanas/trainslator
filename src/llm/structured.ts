import { z } from "zod";

/**
 * AI output schemas follow OpenAI strict mode, the strictest common target:
 * root object, every object closed and fully required, optional = nullable,
 * no free-form records, no allOf/oneOf/const/tuples, nesting ≤ 10.
 */

export type JsonSchema = { [key: string]: unknown };

const STRIP_KEYS = new Set([
  "$schema",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "default",
  "examples",
  "title",
]);

const FORBIDDEN_KEYS = [
  "$ref",
  "$defs",
  "definitions",
  "const",
  "prefixItems",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
];

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!isObject(node)) return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIP_KEYS.has(key)) continue;
    if (key === "properties" && isObject(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, normalize(sub)]),
      );
      continue;
    }
    out[key] = normalize(value);
  }
  // type: ["string", "null"] → anyOf: [{type: "string"}, {type: "null"}]
  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    const { type: _drop, ...rest } = out;
    if (types.length === 1) return { ...rest, type: types[0] };
    const nonNull = types.filter((t) => t !== "null");
    const branches: JsonSchema[] = nonNull.map((t) => ({ ...rest, type: t }));
    if (types.includes("null")) branches.push({ type: "null" });
    const description = rest.description;
    const anyOf = branches.map((b) => {
      const { description: _d, ...clean } = b;
      return clean;
    });
    return description === undefined ? { anyOf } : { anyOf, description };
  }
  return out;
}

/** Converts a zod schema into a strict-mode JSON Schema. Throws if it can't be made strict. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    reused: "inline",
    cycles: "throw",
    unrepresentable: "throw",
  }) as JsonSchema;
  const normalized = normalize(raw) as JsonSchema;
  const problems = checkStrictSchema(normalized);
  if (problems.length > 0) {
    throw new Error(`Schema isn't strict-mode compatible:\n- ${problems.join("\n- ")}`);
  }
  return normalized;
}

/** Lists every way a JSON Schema breaks the strict-mode rules. Empty = OK. */
export function checkStrictSchema(schema: JsonSchema): string[] {
  const problems: string[] = [];
  let propertyCount = 0;

  if (schema.type !== "object") problems.push("root must be an object");
  if ("anyOf" in schema) problems.push("root can't use anyOf");

  function visit(node: unknown, where: string, depth: number): void {
    if (!isObject(node)) {
      problems.push(`${where}: schema node must be an object`);
      return;
    }
    if (depth > 10) problems.push(`${where}: nested deeper than 10 levels`);
    for (const key of FORBIDDEN_KEYS) {
      if (key in node) problems.push(`${where}: "${key}" isn't allowed`);
    }
    if (Array.isArray(node.type)) problems.push(`${where}: type arrays must be anyOf`);
    if (Array.isArray(node.anyOf)) {
      node.anyOf.forEach((branch, i) => {
        visit(branch, `${where}.anyOf[${i}]`, depth);
      });
      return;
    }
    const type = node.type;
    if (type === "object") {
      if (node.additionalProperties !== false) {
        problems.push(`${where}: objects need additionalProperties: false`);
      }
      const props = isObject(node.properties) ? node.properties : {};
      const names = Object.keys(props);
      propertyCount += names.length;
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      for (const name of names) {
        if (!required.includes(name)) {
          problems.push(`${where}.${name}: every property must be required (use nullable)`);
        }
        visit(props[name], `${where}.${name}`, depth + 1);
      }
      if (names.length === 0) problems.push(`${where}: objects need at least one property`);
    } else if (type === "array") {
      if (!("items" in node)) problems.push(`${where}: arrays need items`);
      else visit(node.items, `${where}[]`, depth + 1);
    } else if (
      type !== "string" &&
      type !== "number" &&
      type !== "integer" &&
      type !== "boolean" &&
      type !== "null"
    ) {
      problems.push(`${where}: unsupported type ${JSON.stringify(type)}`);
    }
  }

  visit(schema, "$", 1);
  if (propertyCount > 5000) problems.push("more than 5000 properties in total");
  return problems;
}

function allowsNull(node: unknown): boolean {
  if (!isObject(node)) return false;
  if (node.type === "null") return true;
  if (Array.isArray(node.type) && node.type.includes("null")) return true;
  return Array.isArray(node.anyOf) && (node.anyOf as unknown[]).some(allowsNull);
}

/**
 * Fills in keys a reply left out: null where the schema allows null, an
 * empty list where it expects a list. Models without enforced structured
 * output often skip keys they consider empty, and asking again would mean
 * re-generating the whole answer. Returns a copy; values that don't fit the
 * schema are left for validation.
 */
export function fillMissingNulls(value: unknown, schema: unknown): unknown {
  if (!isObject(schema)) return value;
  if (Array.isArray(schema.anyOf)) {
    const branch = (schema.anyOf as unknown[]).find(
      (b) =>
        isObject(b) &&
        ((b.type === "object" && isObject(value) && !Array.isArray(value)) ||
          (b.type === "array" && Array.isArray(value))),
    );
    return branch ? fillMissingNulls(value, branch) : value;
  }
  if (schema.type === "array" && Array.isArray(value)) {
    return value.map((v) => fillMissingNulls(v, schema.items));
  }
  if (schema.type === "object" && isObject(value) && !Array.isArray(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    const out: Record<string, unknown> = { ...value };
    for (const [key, sub] of Object.entries(props)) {
      if (key in out) out[key] = fillMissingNulls(out[key], sub);
      else if (allowsNull(sub)) out[key] = null;
      else if (isObject(sub) && sub.type === "array") out[key] = [];
    }
    return out;
  }
  return value;
}

/**
 * Compact, readable description of a schema, used in the prompt when the model
 * can't be given the schema through response_format.
 */
export function describeSchema(schema: JsonSchema): string {
  function render(node: unknown, indent: string): string {
    if (!isObject(node)) return "unknown";
    if (Array.isArray(node.anyOf)) {
      return (node.anyOf as unknown[]).map((b) => render(b, indent)).join(" | ");
    }
    if (Array.isArray(node.enum)) {
      return (node.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
    }
    switch (node.type) {
      case "object": {
        const props = isObject(node.properties) ? node.properties : {};
        const inner = `${indent}  `;
        const lines = Object.entries(props).map(([name, sub]) => {
          const desc =
            isObject(sub) && typeof sub.description === "string" ? `  // ${sub.description}` : "";
          return `${inner}"${name}": ${render(sub, inner)}${desc}`;
        });
        return `{\n${lines.join(",\n")}\n${indent}}`;
      }
      case "array":
        return `[ ${render(node.items, indent)} ]`;
      case "integer":
        return "integer";
      default:
        return String(node.type);
    }
  }
  return render(schema, "");
}
