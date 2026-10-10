import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import type { Connection } from "../shared/schemas/settings.ts";

/**
 * SDK clients per connection. Requests go through undici with its header
 * and body timeouts switched off: Node's built-in fetch gives up after 5
 * minutes without data, which kills long reasoning calls. Our own deadline
 * and idle watchdog (watch.ts) replace those timeouts.
 */

export const dispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 30_000,
});

/** fetch without the 5-minute limits, for SDKs and our own HTTP calls. */
export const longFetch = ((input: Parameters<typeof undiciFetch>[0], init = {}) =>
  undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;

export function resolveApiKey(connection: Connection): string {
  const key = connection.apiKey;
  if (key.kind === "literal") return key.value;
  if (key.kind === "env") {
    const value = process.env[key.name];
    if (!value)
      throw new Error(
        `The environment variable ${key.name} (API key for "${connection.name}") isn't set.`,
      );
    return value;
  }
  // Local servers usually accept any key.
  return "no-key";
}

/** The base URL without trailing slashes and without a version or API suffix a user may paste. */
export function rootUrl(connection: Connection, suffixes: RegExp): string {
  return connection.baseUrl.replace(/\/+$/, "").replace(suffixes, "");
}

function headersOf(connection: Connection): Record<string, string> {
  return Object.fromEntries(connection.headers.map((h) => [h.name, h.value]));
}

export class ClientPool {
  private readonly clients = new Map<string, { signature: string; client: OpenAI }>();
  private readonly anthropicClients = new Map<string, { signature: string; client: Anthropic }>();

  private signature(connection: Connection, apiKey: string): string {
    return JSON.stringify([connection.baseUrl, apiKey, connection.headers, connection.maxRetries]);
  }

  /** OpenAI-compatible Chat Completions. */
  get(connection: Connection): OpenAI {
    const apiKey = resolveApiKey(connection);
    const signature = this.signature(connection, apiKey);
    const cached = this.clients.get(connection.id);
    if (cached && cached.signature === signature) return cached.client;
    const client = new OpenAI({
      apiKey,
      baseURL: connection.baseUrl.replace(/\/+$/, ""),
      defaultHeaders: headersOf(connection),
      maxRetries: connection.maxRetries,
      timeout: connection.timeoutSec * 1000,
      fetch: longFetch,
    });
    this.clients.set(connection.id, { signature, client });
    return client;
  }

  /** Anthropic's Messages API. */
  anthropic(connection: Connection): Anthropic {
    const apiKey = resolveApiKey(connection);
    const signature = this.signature(connection, apiKey);
    const cached = this.anthropicClients.get(connection.id);
    if (cached && cached.signature === signature) return cached.client;
    const client = new Anthropic({
      apiKey,
      // The SDK adds /v1/... itself.
      baseURL: rootUrl(connection, /\/v1$/),
      defaultHeaders: headersOf(connection),
      maxRetries: connection.maxRetries,
      timeout: connection.timeoutSec * 1000,
      fetch: longFetch,
    });
    this.anthropicClients.set(connection.id, { signature, client });
    return client;
  }
}
