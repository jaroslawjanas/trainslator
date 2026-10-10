import {
  Anchor,
  Button,
  Drawer,
  Group,
  Progress,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconActivity } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { get, post } from "../api/client.ts";
import { jobLabel } from "../api/live.ts";
import type { Job } from "../api/types.ts";
import { plural, relativeTime } from "../lib/format.ts";
import { ACTIVE_JOB } from "../lib/stages.ts";
import { StageMark } from "./StageMark.tsx";

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => get<{ jobs: Job[] }>("/api/jobs"),
    refetchInterval: 30_000,
  });
}

const STATUS_TEXT: Record<Job["status"], string> = {
  queued: "Waiting to start",
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  failed: "Failed",
  done: "Done",
  done_with_errors: "Done, with errors",
};

const STATUS_COLOR: Partial<Record<Job["status"], string>> = {
  failed: "var(--tr-red)",
  done_with_errors: "var(--tr-ochre)",
  interrupted: "var(--tr-ochre)",
  done: "var(--tr-bookcloth)",
};

/** Where a job's results are shown. */
export function jobHref(job: Job): string {
  const base = `/projects/${job.projectId}`;
  if (job.targetKind === "pair") return `${base}/pairs/${job.targetId}/learn`;
  if (job.targetKind === "book") {
    const stage =
      job.type === "phase2"
        ? "read"
        : job.type === "build"
          ? "build"
          : job.type === "phase3" || job.type === "retranslate"
            ? "translate"
            : "";
    return `${base}/books/${job.targetId}/${stage}`;
  }
  return job.type === "language-notes" ? `${base}/notes` : base;
}

function detailText(job: Job): string {
  const parts: string[] = [];
  if (job.error) parts.push(job.error);
  else if (job.progress.label) parts.push(job.progress.label);
  const extra: string[] = [];
  if (ACTIVE_JOB.includes(job.status) && job.progress.total > 0)
    extra.push(`${job.progress.done} of ${job.progress.total}`);
  if (job.itemErrors > 0) extra.push(`${job.itemErrors} failed`);
  if (job.usage.calls > 0) extra.push(plural(job.usage.calls, "request"));
  if (job.usage.cost !== null) extra.push(`$${job.usage.cost.toFixed(3)}`);
  if (extra.length) parts.push(extra.join(", "));
  return parts.join(". ");
}

/** One job: what it is, how far it got, and the controls that apply. */
export function JobRow({ job, showTitle = true }: { job: Job; showTitle?: boolean }) {
  const client = useQueryClient();
  const act = async (action: "pause" | "resume" | "cancel") => {
    try {
      await post(`/api/jobs/${job.id}/${action}`);
      void client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Couldn't change the job",
        message: (error as Error).message,
      });
    }
  };
  const active = ACTIVE_JOB.includes(job.status);
  const pct =
    job.progress.total > 0 ? (job.progress.done / job.progress.total) * 100 : active ? 100 : 0;
  const when = job.finishedAt ?? job.startedAt ?? job.createdAt;
  return (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm" lineClamp={1}>
          {showTitle && (
            <Text span fw={500}>
              {jobLabel(job)}{" "}
            </Text>
          )}
          <Text span c={STATUS_COLOR[job.status] ?? "var(--tr-graphite)"} size="sm">
            {STATUS_TEXT[job.status]}
          </Text>
          {!active && when && (
            <Text span size="xs" c="dimmed">
              {" "}
              {relativeTime(when)}
            </Text>
          )}
        </Text>
        <Group gap={4} wrap="nowrap">
          {(job.status === "running" || job.status === "queued") && (
            <Button size="compact-xs" variant="default" onClick={() => act("pause")}>
              Pause
            </Button>
          )}
          {["paused", "interrupted", "failed", "done_with_errors"].includes(job.status) && (
            <Button size="compact-xs" variant="light" onClick={() => act("resume")}>
              {job.status === "done_with_errors" ? "Retry failed" : "Resume"}
            </Button>
          )}
          {active && (
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => act("cancel")}>
              Cancel
            </Button>
          )}
        </Group>
      </Group>
      {active && <Progress value={pct} animated={job.status === "running"} />}
      <Text size="xs" c="dimmed" lineClamp={3}>
        {detailText(job)}
      </Text>
    </Stack>
  );
}

/** The latest job for each target and kind of work; older runs of the same work are hidden. */
function latestPerTarget(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const j of jobs) {
    const key = `${j.targetId}:${j.type === "retranslate" ? "phase3" : j.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

/** Sidebar entry: running work at a glance; opens the activity drawer. */
export function ActivityButton() {
  const { data } = useJobs();
  const [open, setOpen] = useState(false);
  const jobs = data?.jobs ?? [];
  const active = jobs.filter((j) => ACTIVE_JOB.includes(j.status));
  const recent = latestPerTarget(jobs.filter((j) => !ACTIVE_JOB.includes(j.status))).slice(0, 10);
  const first = active[0];
  const pct =
    first && first.progress.total > 0 ? (first.progress.done / first.progress.total) * 100 : 0;
  return (
    <>
      <UnstyledButton className="tr-nav-link" onClick={() => setOpen(true)}>
        {first ? <StageMark state="running" /> : <IconActivity size={16} stroke={1.6} />}
        <span className="tr-nav-text">
          {first
            ? `${jobLabel(first)}${active.length > 1 ? ` and ${active.length - 1} more` : ""}`
            : "Activity"}
        </span>
        {first && first.progress.total > 0 && (
          <Text span size="xs" c="dimmed" className="num">
            {Math.round(pct)}%
          </Text>
        )}
      </UnstyledButton>
      <Drawer opened={open} onClose={() => setOpen(false)} title="Activity" position="right">
        <Stack gap="xl">
          {active.length > 0 && (
            <Stack gap="md">
              <Text size="sm" c="dimmed">
                Running
              </Text>
              {active.map((job) => (
                <Stack key={job.id} gap={4}>
                  <JobRow job={job} />
                  <Anchor
                    component={Link}
                    to={jobHref(job)}
                    size="xs"
                    onClick={() => setOpen(false)}
                  >
                    Go there
                  </Anchor>
                </Stack>
              ))}
            </Stack>
          )}
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              {active.length > 0 ? "Finished" : "Latest work"}
            </Text>
            {recent.length === 0 && (
              <Text size="sm" c="dimmed">
                Nothing has run yet. Jobs appear here when you run a phase or a build.
              </Text>
            )}
            {recent.map((job) => (
              <Stack key={job.id} gap={4}>
                <JobRow job={job} />
                <Anchor component={Link} to={jobHref(job)} size="xs" onClick={() => setOpen(false)}>
                  Go there
                </Anchor>
              </Stack>
            ))}
          </Stack>
        </Stack>
      </Drawer>
    </>
  );
}
