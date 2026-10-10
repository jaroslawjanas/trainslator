export type LlmErrorKind =
  | "transport"
  | "rate_limit"
  | "auth"
  | "bad_request"
  | "invalid_output"
  | "truncated"
  | "reasoning_exhausted"
  | "refusal"
  | "context_overflow"
  | "context_truncated"
  | "aborted"
  | "config";

/**
 * 404 and 405 mean the request went to the wrong place (a wrong base URL,
 * http instead of https, a model name the server doesn't have). Every
 * request would fail the same way, so they stop a job at once.
 */
export function wrongAddressError(status: number, detail: string, cause?: unknown): LlmError {
  const hint =
    status === 405
      ? "the server doesn't accept this request at that address. Check the base URL: hosted APIs need https://, and OpenAI-compatible addresses usually end in /v1"
      : "the server doesn't know this address or model. Check the base URL and the model name";
  return new LlmError(
    "config",
    `${status === 405 ? "405 Method Not Allowed" : "404 Not Found"}: ${hint}. (${detail})`,
    {
      status,
      cause,
    },
  );
}

/** Errors from the LLM layer, with a kind that callers can act on. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** Raw model output, when there was any. */
  readonly raw: string | null;
  readonly status: number | null;

  constructor(
    kind: LlmErrorKind,
    message: string,
    options: { raw?: string | null; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmError";
    this.kind = kind;
    this.raw = options.raw ?? null;
    this.status = options.status ?? null;
  }
}

export function isLlmError(error: unknown, kind?: LlmErrorKind): error is LlmError {
  return error instanceof LlmError && (kind === undefined || error.kind === kind);
}
