import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Connection } from "../shared/schemas/settings.ts";
import { type FakeReply, type FakeServer, startFakeOpenAI } from "../testing/fake-openai.ts";
import {
  makeConnection,
  makeModel,
  makeRuntime,
  makeStep,
  type TestRuntime,
} from "../testing/llm-fixtures.ts";
import { type AdvisorTarget, advisorTool } from "./advisor.ts";
import { type CallSpec, callStructured } from "./call.ts";
import { buildRequestBody, type RequestPlan } from "./request.ts";
import { toStrictJsonSchema } from "./structured.ts";

const Answer = z.object({ items: z.array(z.object({ id: z.string(), text: z.string() })) });
type Answer = z.infer<typeof Answer>;
const VALID = JSON.stringify({ items: [{ id: "u1", text: "Dzień dobry, Miro" }] });
const QUESTION = 'Passage: "Good morning, Mira." Should "Mira" stay as it is in Polish?';
const ADVICE = "Keep it: Mira is a name, and the knowledge base has no other form.";

let server: FakeServer | null = null;
let env: TestRuntime | null = null;
afterEach(async () => {
  await server?.close();
  await env?.cleanup();
  server = null;
  env = null;
});

type Messages = { role: string; content?: unknown; tool_calls?: unknown[] }[];
const messagesOf = (body: Record<string, unknown>) => body.messages as Messages;
const isAdvisor = (body: Record<string, unknown>) => body.model === "advisor-model";
const toolTurns = (body: Record<string, unknown>) =>
  messagesOf(body).filter((m) => m.role === "tool").length;

function askAdvisor(id = "call_1"): FakeReply {
  return {
    toolCalls: [{ id, name: "ask_advisor", arguments: JSON.stringify({ question: QUESTION }) }],
  };
}

async function setup(
  executor: (body: Record<string, unknown>) => FakeReply,
  advisor: (body: Record<string, unknown>) => FakeReply = () => ({ content: ADVICE }),
  conn: Partial<Connection> = {},
) {
  server = await startFakeOpenAI((body) => (isAdvisor(body) ? advisor(body) : executor(body)));
  const connection = makeConnection(server.url, { kind: "openai", ...conn });
  env = await makeRuntime(connection, makeModel("openai"));
}

function spec(): CallSpec<Answer> {
  return {
    projectId: "pr_test",
    step: "phase3.translate",
    label: "chunk 1",
    blocks: [
      { role: "system", label: "instructions", text: "Translate into Polish." },
      { role: "user", label: "chunk", text: '[{"id":"u1","text":"Good morning, Mira."}]' },
    ],
    schema: Answer,
    schemaName: "translation",
    answerBudget: 500,
    useCache: false,
  };
}

function call(maxConsultations = 3) {
  const connection = env!.settings.connections[0]!;
  const advisor: AdvisorTarget = {
    connection,
    model: makeModel("openai", { id: "advisor1", modelName: "advisor-model", label: "Advisor" }),
    step: makeStep({ modelId: "advisor1" }),
    maxConsultations,
  };
  return callStructured(
    env!.rt,
    { connection, model: env!.settings.models[0]!, step: makeStep(), advisor },
    spec(),
  );
}

describe("the advisor", () => {
  it.each([false, true])(
    "answers the model's question, and the model continues (streaming %s)",
    async (stream) => {
      await setup(
        (body) => (toolTurns(body) === 0 ? askAdvisor() : { content: VALID }),
        undefined,
        {
          stream,
        },
      );
      const result = await call();
      expect(result.value.items[0]!.text).toBe("Dzień dobry, Miro");
      expect(result.usage.calls).toBe(3);

      const [first, asked, second] = server!.requests;
      expect(server!.requests).toHaveLength(3);
      // The model is offered the tool next to the required structure.
      expect((first!.tools as { function: { name: string } }[])[0]!.function.name).toBe(
        "ask_advisor",
      );
      expect(first!.response_format).toMatchObject({ type: "json_schema" });
      // The advisor sees the question only: no translation instructions, no text, no tools.
      const advisorMessages = messagesOf(asked!);
      expect(advisorMessages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(advisorMessages[1]!.content).toBe(`${QUESTION}\n\n`);
      expect(JSON.stringify(asked)).not.toContain("Translate into Polish");
      expect(asked!.tools).toBeUndefined();
      expect(asked!.response_format).toBeUndefined();
      // The model gets its call back with the advice.
      const tail = messagesOf(second!).slice(-2);
      expect(tail[0]).toMatchObject({
        role: "assistant",
        tool_calls: [{ id: "call_1", function: { name: "ask_advisor" } }],
      });
      expect(tail[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: ADVICE });
    },
  );

  it("stops consulting after the limit and asks the model to finish", async () => {
    await setup((body) =>
      toolTurns(body) < 2 ? askAdvisor(`call_${toolTurns(body)}`) : { content: VALID },
    );
    const result = await call(1);
    expect(result.value.items).toHaveLength(1);
    expect(server!.requests.filter(isAdvisor)).toHaveLength(1);
    const last = messagesOf(server!.requests.at(-1)!).at(-1)!;
    expect(last.content).toContain("once already");
  });

  it("lets the model carry on when the advisor fails", async () => {
    await setup(
      (body) => (toolTurns(body) === 0 ? askAdvisor() : { content: VALID }),
      () => ({ status: 500, errorMessage: "advisor down" }),
    );
    const result = await call();
    expect(result.value.items).toHaveLength(1);
    expect(server!.requests.filter(isAdvisor)).toHaveLength(3);
    const last = messagesOf(server!.requests.at(-1)!).at(-1)!;
    expect(last.content).toContain("The advisor couldn't answer");
  });

  it("offers no tool when the step may not consult it", async () => {
    await setup(() => ({ content: VALID }));
    const connection = env!.settings.connections[0]!;
    await callStructured(
      env!.rt,
      { connection, model: env!.settings.models[0]!, step: makeStep() },
      spec(),
    );
    expect(server!.requests[0]!.tools).toBeUndefined();
  });
});

describe("tool calls in the native APIs", () => {
  const schema = toStrictJsonSchema(Answer);
  const turn = {
    kind: "tools" as const,
    assistant: { role: "assistant", content: [{ type: "tool_use", id: "tu_1" }] },
    results: [{ id: "tu_1", name: "ask_advisor", content: ADVICE }],
  };
  const plan = (overrides: Partial<RequestPlan> = {}): RequestPlan => ({
    blocks: [
      { role: "system", label: "instructions", text: "Translate." },
      { role: "user", label: "chunk", text: "Hello" },
    ],
    schemaName: "translation",
    jsonSchema: schema,
    answerBudget: 500,
    reasoningAllowance: 0,
    turns: [],
    tools: [advisorTool(2)],
    promptCacheKey: null,
    ...overrides,
  });

  it("offers Ollama the tool without forcing the schema, which would rule out calls", () => {
    const body = buildRequestBody(
      makeConnection("http://x", { kind: "ollama_cloud" }),
      makeModel("ollama_cloud"),
      makeStep(),
      plan({ turns: [{ ...turn, assistant: { role: "assistant", tool_calls: [] } }] }),
      false,
    );
    expect(body.format).toBeUndefined();
    expect((body.tools as { function: { name: string } }[])[0]!.function.name).toBe("ask_advisor");
    expect(messagesOf(body).at(-1)).toEqual({
      role: "tool",
      content: ADVICE,
      tool_name: "ask_advisor",
    });
    // The structure is still described in the prompt.
    expect(String(messagesOf(body)[0]!.content)).toContain('"items"');
  });

  it("sends Anthropic the tool and the advice as a tool result", () => {
    const body = buildRequestBody(
      makeConnection("http://x", { kind: "anthropic" }),
      makeModel("anthropic"),
      makeStep(),
      plan({ turns: [turn] }),
      false,
    );
    expect((body.tools as { name: string; input_schema: unknown }[])[0]).toMatchObject({
      name: "ask_advisor",
      input_schema: { required: ["question"] },
    });
    const messages = messagesOf(body);
    expect(messages.at(-2)).toEqual(turn.assistant);
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: ADVICE }],
    });
  });
});
