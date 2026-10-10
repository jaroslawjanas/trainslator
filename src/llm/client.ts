import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import type { Connection } from "../shared/schemas/settings.ts";

/**
 * One SDK client per connection. Requests go through undici with its header
 * and body timeouts switched off: Node's built-in fetch gives up after 5
 * minutes without data, which kills long reasoning calls. Our own deadline
 * and idle watchdog (call.ts) replace those timeouts.
 */

const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 30_000 });

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

export class ClientPool {
  private readonly clients = new Map<string, { signature: string; client: OpenAI }>();

  get(connection: Connection): OpenAI {
    const apiKey = resolveApiKey(connection);
    const signature = JSON.stringify([
      connection.baseUrl,
      apiKey,
      connection.headers,
      connection.maxRetries,
    ]);
    const cached = this.clients.get(connection.id);
    if (cached && cached.signature === signature) return cached.client;
    const client = new OpenAI({
      apiKey,
      baseURL: connection.baseUrl.replace(/\/+$/, ""),
      defaultHeaders: Object.fromEntries(connection.headers.map((h) => [h.name, h.value])),
      maxRetries: connection.maxRetries,
      timeout: connection.timeoutSec * 1000,
      fetch: undiciFetch as unknown as typeof fetch,
      fetchOptions: { dispatcher } as unknown as NonNullable<
        ConstructorParameters<typeof OpenAI>[0]
      >["fetchOptions"],
    });
    this.clients.set(connection.id, { signature, client });
    return client;
  }
}
