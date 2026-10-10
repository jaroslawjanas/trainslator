/**
 * A stand-in for `claude -p` in tests, run with node. It records what it was
 * given (arguments, stdin, the system-prompt file, whether an API key was
 * in its environment) and prints a reply in the requested output format.
 * FAKE_CLAUDE holds its settings as JSON: { log, reply?, error? }.
 */
import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.env.FAKE_CLAUDE ?? "{}");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const systemFile = flag("--system-prompt-file");
  writeFileSync(
    config.log,
    JSON.stringify({
      args,
      stdin,
      system: systemFile ? readFileSync(systemFile, "utf8") : null,
      apiKeyInEnv: Boolean(process.env.ANTHROPIC_API_KEY),
      nested: Boolean(process.env.CLAUDECODE),
    }),
  );
  const schema = flag("--json-schema");
  const reply = config.reply ?? "Dzień dobry";
  const result = config.error
    ? { type: "result", subtype: "success", is_error: true, ...config.error }
    : {
        type: "result",
        subtype: "success",
        is_error: false,
        result: typeof reply === "string" ? reply : JSON.stringify(reply),
        ...(schema ? { structured_output: reply } : {}),
        stop_reason: schema ? "tool_use" : "end_turn",
        total_cost_usd: 0.0012,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 600,
          output_tokens: 40,
          output_tokens_details: { thinking_tokens: 25 },
        },
        modelUsage: { "claude-haiku-5-5": { contextWindow: 1_000_000 } },
      };
  if (flag("--output-format") === "stream-json") {
    const line = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
    line({ type: "system", subtype: "init", model: "claude-haiku-5-5" });
    line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Hmm." } },
    });
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"items": [' },
      },
    });
    if (config.rateLimit) line({ type: "rate_limit_event", rate_limit_info: config.rateLimit });
    line(result);
  } else {
    process.stdout.write(JSON.stringify(result));
  }
  process.exitCode = config.error ? 1 : 0;
});
