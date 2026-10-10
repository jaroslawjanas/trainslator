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
