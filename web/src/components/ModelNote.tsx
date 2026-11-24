import { Anchor, Stack, Text } from "@mantine/core";
import { Link } from "react-router";
import { STEP_INFO, type Step } from "../../../src/shared/steps.ts";
import { useSettings } from "../pages/SettingsPage.tsx";

/** Efforts at which a single request can think for many minutes. */
const SLOW_EFFORTS = new Set(["high", "xhigh", "max"]);

/**
 * Which model each step uses, and one quiet tip for settings that make it
 * slow: a high reasoning effort, or Ollama reached through its
 * OpenAI-compatible address (which ignores the output limit).
 */
export function ModelNote({ steps }: { steps: Step[] }) {
  const settings = useSettings();
  const s = settings.data?.settings;
  if (!s) return null;
  const rows = steps.map((step) => {
    const config = s.steps[step];
    const model = s.models.find((m) => m.id === config.modelId);
    const connection = s.connections.find((c) => c.id === model?.connectionId);
    const effort = config.reasoning.enabled ? config.reasoning.effort : null;
    const advisor =
      s.advisor.enabled && config.consultAdvisor && connection?.kind !== "claude_code"
        ? s.models.find((m) => m.id === s.advisor.modelId)
        : undefined;
    return { step, config, model, connection, effort, advisor };
  });
  const tips: { text: string; fix: string; to: string }[] = [];
  const slow = [
    ...new Set(rows.map((r) => r.effort).filter((e) => e !== null && SLOW_EFFORTS.has(e))),
  ];
  if (slow.length > 0)
    tips.push({
      text: `Reasoning effort ${slow.join(" and ")} lets each request think for a long time, often several minutes. A lower effort is usually enough ${rows.length > 1 ? "for these steps" : "for this step"} and much faster.`,
      fix: "Change the effort",
      to: "/settings/steps",
    });
  const viaOpenAi = new Set<string>();
  for (const { connection } of rows)
    if (connection && connection.kind !== "ollama_cloud" && /ollama\.com/i.test(connection.baseUrl))
      viaOpenAi.add(connection.name);
  for (const name of viaOpenAi)
    tips.push({
      text: `"${name}" reaches Ollama Cloud through its OpenAI-compatible address, which ignores the output limit. An Ollama Cloud connection is faster.`,
      fix: "Add an Ollama Cloud connection",
      to: "/settings/connections",
    });
  return (
    <Stack gap={4} mt="sm" pl={22}>
      {rows.map(({ step, config, model, effort, advisor }) => (
        <Text key={step} size="sm" c="dimmed">
          {STEP_INFO[step].label
            .replace(/^(Learning|Reading): /, "")
            .replace(/^./, (c) => c.toUpperCase())}
          {": "}
          {model ? (
            <>
              <Text span size="sm" c="var(--tr-ink)">
                {model.label || model.modelName}
              </Text>
              {config.reasoning.enabled
                ? effort
                  ? `, reasoning at effort ${effort}`
                  : ", reasoning on"
                : ", no reasoning"}
              {advisor && (
                <>
                  , may ask{" "}
                  <Text span size="sm" c="var(--tr-ink)">
                    {advisor.label || advisor.modelName}
                  </Text>{" "}
                  for advice
                </>
              )}
              .
            </>
          ) : (
            "no model chosen."
          )}
        </Text>
      ))}
      {tips.map((t) => (
        <Text key={t.text} size="sm" c="dimmed" className="tr-tip" mt={4}>
          {t.text}{" "}
          <Anchor component={Link} to={t.to} size="sm">
            {t.fix}
          </Anchor>
        </Text>
      ))}
    </Stack>
  );
}
