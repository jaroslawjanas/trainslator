import { Box, Button, Group, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { Job } from "../api/types.ts";
import { relativeTime } from "../lib/format.ts";
import { ACTIVE_JOB, type MarkState, phaseMark, phaseText } from "../lib/stages.ts";
import { JobRow } from "./JobsIndicator.tsx";
import { StageMark } from "./StageMark.tsx";

export interface Pricing {
  inputPerM: number;
  cachedInputPerM?: number;
  outputPerM: number;
}

/** "About 90,000 input tokens (27,000 of them cacheable) and 9,000 output tokens, about $0.12." */
export function estimateText(e: {
  input: number;
  cached?: number;
  output: number;
  pricing: Pricing | null | undefined;
  prefix?: string;
}): string {
  const cached =
    e.cached && e.cached > 0 ? ` (${e.cached.toLocaleString()} of them cacheable)` : "";
  let text = `${e.prefix ?? "About"} ${e.input.toLocaleString()} input tokens${cached} and ${e.output.toLocaleString()} output tokens`;
  if (e.pricing) {
    const fresh = e.input - (e.cached ?? 0);
    const cachedPrice = e.pricing.cachedInputPerM ?? e.pricing.inputPerM;
    const cost =
      (fresh * e.pricing.inputPerM +
        (e.cached ?? 0) * cachedPrice +
        e.output * e.pricing.outputPerM) /
      1_000_000;
    text += `, about $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}.`;
  } else {
    text += ". Add the model's prices in Settings to see the cost.";
  }
  return text;
}

/**
 * The state of one phase (or the build) and its main action. Shows progress
 * while it runs, the result when it's done, and the estimate only when
 * there is work left to do.
 */
export function RunPanel({
  state,
  finishedAt,
  job,
  summary,
  estimate,
  actionLabel,
  onRun,
  disabled,
  hideAction,
  extra,
  children,
}: {
  state: string;
  finishedAt?: string | null;
  job: Job | undefined;
  summary?: ReactNode;
  estimate?: ReactNode;
  actionLabel: string;
  onRun: () => void;
  disabled?: boolean;
  /** Nothing left to do: no main action. */
  hideAction?: boolean;
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const running = job !== undefined && ACTIVE_JOB.includes(job.status);
  const mark: MarkState = running ? "running" : phaseMark(state);
  const done = state === "done" || state === "done_with_errors";
  return (
    <Box
      p="md"
      mb="xl"
      style={{
        background: "var(--tr-desk)",
        borderRadius: 6,
        border: "1px solid var(--tr-rule)",
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Stack gap={4} style={{ flex: "1 1 360px", minWidth: 0 }}>
          <Group gap={8} wrap="nowrap">
            <StageMark state={mark} />
            <Text fw={500} size="md">
              {running ? "Running" : phaseText(state)}
              {!running && done && finishedAt && (
                <Text span c="dimmed" fw={400}>
                  {" "}
                  {relativeTime(finishedAt)}
                </Text>
              )}
            </Text>
          </Group>
          {!running && summary && (
            <Text size="sm" c="dimmed" pl={22}>
              {summary}
            </Text>
          )}
          {!running && estimate && (
            <Text size="sm" c="dimmed" pl={22}>
              {estimate}
            </Text>
          )}
        </Stack>
        <Group gap="xs">
          {extra}
          {!running && !hideAction && (
            <Button variant={done ? "default" : "filled"} onClick={onRun} disabled={disabled}>
              {actionLabel}
            </Button>
          )}
        </Group>
      </Group>
      {job && (running || ["failed", "paused", "interrupted"].includes(job.status)) && (
        <Box mt="md">
          <JobRow job={job} showTitle={false} />
        </Box>
      )}
      {children}
    </Box>
  );
}
