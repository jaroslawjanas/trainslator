import { Box, Button, Group, Menu, Portal, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import type { Job, Settings } from "../api/types.ts";
import { relativeTime } from "../lib/format.ts";
import { ACTIVE_JOB, type MarkState, phaseMark, phaseText } from "../lib/stages.ts";
import { JobDetails } from "./JobDetails.tsx";
import { JobRow } from "./JobsIndicator.tsx";
import { HEADER_STATUS } from "./PageHeader.tsx";
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

/** Another way to run the same step, e.g. "Read the whole book again". */
export interface RunAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/** One button, or a "Run again" menu when there is more than one way to run. */
function RunActions({ actions }: { actions: RunAction[] }) {
  const only = actions[0];
  if (!only) return null;
  if (actions.length === 1)
    return (
      <Button variant="default" onClick={only.onClick} disabled={only.disabled}>
        {only.label}
      </Button>
    );
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Button variant="default" rightSection={<IconChevronDown size={14} />}>
          Run again
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {actions.map((a) => (
          <Menu.Item key={a.label} onClick={a.onClick} disabled={a.disabled}>
            {a.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The state of one step (or the build) and its main action. Before a run it
 * is a panel with the estimate, the models and the options. While it runs it
 * shows progress. Once it has finished cleanly it is one line beside the
 * page title, with the rest behind "Details".
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
  secondary,
  always,
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
  /** Shown beside the actions in every state, e.g. a download. */
  extra?: ReactNode;
  /** Other ways to run the step, offered once it has run. */
  secondary?: RunAction[];
  /** Options that must stay in sight in every state. */
  always?: ReactNode;
  /** Models and options: in the panel before a run, behind "Details" after it. */
  children?: ReactNode;
}) {
  const running = job !== undefined && ACTIVE_JOB.includes(job.status);
  // Saved as running but no job runs (e.g. the page hasn't caught up with a restart).
  const shown = !running && state === "running" ? "stopped" : state;
  const mark: MarkState = running ? "running" : phaseMark(shown);
  const done = shown === "done" || shown === "done_with_errors";
  const troubled = job !== undefined && ["failed", "paused", "interrupted"].includes(job.status);
  // A run that finished cleanly needs one line; anything else gets the whole panel.
  const compact = !running && shown === "done" && !troubled;
  const [open, setOpen] = useState(false);
  const others = running ? [] : (secondary ?? []);

  if (compact) {
    const actions = [
      ...(hideAction ? [] : [{ label: actionLabel, onClick: onRun, disabled }]),
      ...others,
    ];
    return (
      <>
        <Portal target={`#${HEADER_STATUS}`}>
          <Group gap="xs" wrap="nowrap" className="tr-run-line">
            <StageMark state="done" />
            <Text size="md" fw={500} style={{ whiteSpace: "nowrap" }}>
              Done
              {finishedAt && (
                <Text span c="dimmed" fw={400}>
                  {" "}
                  {relativeTime(finishedAt)}
                </Text>
              )}
            </Text>
            {summary && (
              <Text size="sm" c="dimmed" className="tr-run-summary">
                {summary}
              </Text>
            )}
            <Button
              size="compact-sm"
              variant="subtle"
              color="gray"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              Details
            </Button>
            {extra}
            <RunActions actions={actions} />
          </Group>
        </Portal>
        {(always || estimate || open) && (
          <Box mb="lg">
            {estimate && (
              <Text size="sm" c="dimmed" mb={always || open ? "sm" : 0}>
                {estimate}
              </Text>
            )}
            {always}
            {open && (
              <Box className="tr-run-details" mt={always ? "md" : 0}>
                {summary && (
                  <Text size="sm" c="dimmed">
                    {summary}
                  </Text>
                )}
                {children}
                {job && (
                  <Box mt="md">
                    <JobDetails job={job} />
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}
      </>
    );
  }

  return (
    <Box className="tr-run-panel" p="md" mb="xl">
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
          {others.map((a) => (
            <Button key={a.label} variant="default" onClick={a.onClick} disabled={a.disabled}>
              {a.label}
            </Button>
          ))}
          {!running && !hideAction && (
            <Button variant={done ? "default" : "filled"} onClick={onRun} disabled={disabled}>
              {actionLabel}
            </Button>
          )}
        </Group>
      </Group>
      {always}
      {children}
      {job && (running || troubled) && (
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
