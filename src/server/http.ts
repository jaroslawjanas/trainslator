import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { EpubImportError } from "../epub/book.ts";
import { LlmError } from "../llm/errors.ts";
import { NotFoundError, UserError } from "../services/projects.ts";
import { ID_RE } from "../shared/schemas/common.ts";

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: unknown;
  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "bad_json", "The request body isn't valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "invalid",
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** A route parameter that will be used in a file path: only safe ids are accepted. */
export function idParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value || !ID_RE.test(value)) throw new HttpError(400, "bad_id", `Invalid ${name}.`);
  return value;
}

export function intParam(c: Context, name: string): number {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value) || value < 0)
    throw new HttpError(400, "bad_param", `Invalid ${name}.`);
  return value;
}

export function errorResponse(c: Context, error: unknown) {
  if (error instanceof HttpError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details ?? null } },
      error.status,
    );
  }
  if (error instanceof NotFoundError) {
    return c.json({ error: { code: "not_found", message: error.message, details: null } }, 404);
  }
  if (error instanceof UserError) {
    return c.json({ error: { code: "invalid", message: error.message, details: null } }, 400);
  }
  if (error instanceof EpubImportError) {
    return c.json(
      { error: { code: `epub_${error.code}`, message: error.message, details: null } },
      422,
    );
  }
  if (error instanceof LlmError) {
    const status = error.kind === "config" ? 409 : 502;
    return c.json(
      { error: { code: `llm_${error.kind}`, message: error.message, details: null } },
      status,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  return c.json({ error: { code: "error", message, details: null } }, 500);
}
