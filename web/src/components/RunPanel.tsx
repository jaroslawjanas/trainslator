import { Box, Button, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import type { Job, Settings } from "../api/types.ts";
import { relativeTime } from "../lib/format.ts";
import { ACTIVE_JOB, type MarkState, phaseMark, phaseText } from "../lib/stages.ts";
import { JobDetails } from "./JobDetails.tsx";
import { JobRow } from "./JobsIndicator.tsx";
import { StageMark } from "./StageMark.tsx";

export interface Pricing {
  inputPerM: number;
  cachedInputPerM?: number;
  outputPerM: number;
}

/** Whether a model runs on a Claude subscription (Claude Code), so its requests cost nothing. */
export function onSubscription(settings: Settings | undefined, modelId: string | null | undefined) {
  const model = settings?.models.find((m) => m.id === modelId);
  return settings?.connections.find((c) => c.id === model?.connectionId)?.kind === "claude_code";
}

/** "About 90,000 input tokens (27,000 of them cacheable) and 9,000 output tokens, about $0.12." */
export function estimateText(e: {
  input: number;
  cached?: number;
  output: number;
  pricing: Pricing | null | undefined;
  prefix?: string;
  /** Claude Code: the subscription pays. */
  subscription?: boolean;
}): string {
  const cached =
    e.cached && e.cached > 0 ? ` (${e.cached.toLocaleString()} of them cacheable)` : "";
  let text = `${e.prefix ?? "About"} ${e.input.toLocaleString()} input tokens${cached} and ${e.output.toLocaleString()} output tokens`;
  if (e.subscription) {
    text += ", covered by your Claude subscription.";
  } else if (e.pricing) {
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
  // Saved as running but no job runs (e.g. the page hasn't caught up with a restart).
  const shown = !running && state === "running" ? "stopped" : state;
  const mark: MarkState = running ? "running" : phaseMark(shown);
  const done = shown === "done" || shown === "done_with_errors";
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
              {running ? "Running" : phaseText(shown)}
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
      {children}
      {job && (running || ["failed", "paused", "interrupted"].includes(job.status)) && (
        <Box mt="md">
          <JobRow job={job} showTitle={false} />
        </Box>
      )}
      {job && <RunDetails job={job} running={running} />}
    </Box>
  );
}

/** Stages and requests: open while the job runs, behind a toggle afterwards. */
function RunDetails({ job, running }: { job: Job; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (running)
    return (
      <Box mt="md" pt="md" style={{ borderTop: "1px solid var(--tr-rule)" }}>
        <JobDetails job={job} />
      </Box>
    );
  return (
    <Box mt="md">
      <UnstyledButton onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Group gap={4}>
          <IconChevronRight
            size={14}
            style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
          />
          <Text size="sm" c="dimmed">
            Details of the last run
          </Text>
        </Group>
      </UnstyledButton>
      {open && (
        <Box mt="sm">
          <JobDetails job={job} />
        </Box>
      )}
    </Box>
  );
}
