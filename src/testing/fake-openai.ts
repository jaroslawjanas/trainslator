import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

/**
 * A scriptable OpenAI-compatible server for tests. Each request to
 * /v1/chat/completions calls the handler, which describes the reply.
 */

export interface FakeReply {
  content?: string;
  reasoning?: string;
  refusal?: string;
  finishReason?: string | null;
  /** Usage object to report; null = none; undefined = computed defaults. */
  usage?: Record<string, unknown> | null;
  /** HTTP error status instead of a completion. */
  status?: number;
  errorMessage?: string;
  headers?: Record<string, string>;
  /** Wait before answering. */
  delayMs?: number;
  /** Streaming: wait between chunks. */
  chunkDelayMs?: number;
  /** Streaming: stop with a network error after the first chunks. */
  breakMidStream?: boolean;
  /** Streaming: attach usage to the last content chunk (DeepSeek style) instead of a final chunk. */
  usageOnLastContentChunk?: boolean;
}

export type FakeHandler = (
  body: Record<string, unknown>,
  index: number,
) => FakeReply | Promise<FakeReply>;

export interface FakeServer {
  url: string;
  requests: Record<string, unknown>[];
  maxConcurrent: number;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultUsage(body: Record<string, unknown>, content: string): Record<string, unknown> {
  const prompt = Math.ceil(JSON.stringify(body.messages ?? "").length / 4);
  return {
    prompt_tokens: prompt,
    completion_tokens: Math.ceil(content.length / 4),
    total_tokens: prompt + Math.ceil(content.length / 4),
    prompt_tokens_details: { cached_tokens: 0 },
  };
}

export async function startFakeOpenAI(handler: FakeHandler): Promise<FakeServer> {
  const requests: Record<string, unknown>[] = [];
  let active = 0;
  const state = { maxConcurrent: 0 };
  const app = new Hono();

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: [{ id: "fake-model", object: "model", context_length: 32000 }],
    }),
  );

  app.post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const index = requests.length;
    requests.push(body);
    active++;
    state.maxConcurrent = Math.max(state.maxConcurrent, active);
    try {
      const reply = await handler(body, index);
      if (reply.delayMs) await sleep(reply.delayMs);
      if (reply.status && reply.status >= 400) {
        return c.json(
          { error: { message: reply.errorMessage ?? `fake error ${reply.status}`, type: "fake" } },
          reply.status as 400,
          reply.headers,
        );
      }
      const content = reply.content ?? "";
      const usage = reply.usage === undefined ? defaultUsage(body, content) : reply.usage;
      const finish = reply.finishReason === undefined ? "stop" : reply.finishReason;
      const model = String(body.model ?? "fake-model");

      if (!body.stream) {
        return c.json({
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content,
                ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
                ...(reply.refusal ? { refusal: reply.refusal } : {}),
              },
              finish_reason: finish,
            },
          ],
          ...(usage ? { usage } : {}),
        });
      }

      const encoder = new TextEncoder();
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
        encoder.encode(
          `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model, choices, ...extra })}\n\n`,
        );
      const pieces: string[] = [];
      for (let i = 0; i < content.length; i += 12) pieces.push(content.slice(i, i + 12));
      if (pieces.length === 0) pieces.push("");
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            if (reply.reasoning)
              controller.enqueue(
                chunk([
                  {
                    index: 0,
                    delta: { role: "assistant", reasoning_content: reply.reasoning },
                    finish_reason: null,
                  },
                ]),
              );
            if (reply.refusal)
              controller.enqueue(
                chunk([{ index: 0, delta: { refusal: reply.refusal }, finish_reason: null }]),
              );
            for (let i = 0; i < pieces.length; i++) {
              if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
              if (reply.breakMidStream && i === 1) {
                controller.error(new Error("connection reset"));
                return;
              }
              const last = i === pieces.length - 1;
              const extra =
                last && reply.usageOnLastContentChunk && usage ? { usage } : { usage: null };
              controller.enqueue(
                chunk(
                  [
                    {
                      index: 0,
                      delta: { content: pieces[i] },
                      finish_reason: last ? finish : null,
                    },
                  ],
                  extra,
                ),
              );
            }
            if (reply.breakMidStream) {
              controller.error(new Error("connection reset"));
              return;
            }
            if (usage && !reply.usageOnLastContentChunk) controller.enqueue(chunk([], { usage }));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    } finally {
      active--;
    }
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    get maxConcurrent() {
      return state.maxConcurrent;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
