import { Button, Group, Indicator, Popover, Progress, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { get, post } from "../api/client.ts";
import { jobLabel } from "../api/live.ts";
import type { Job } from "../api/types.ts";

const ACTIVE = ["queued", "running", "pausing"];

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => get<{ jobs: Job[] }>("/api/jobs"),
    refetchInterval: 30_000,
  });
}

export function jobColor(status: Job["status"]): string {
  switch (status) {
    case "done":
      return "green";
    case "failed":
      return "red";
    case "done_with_errors":
    case "interrupted":
      return "yellow";
    case "running":
    case "queued":
    case "pausing":
      return "blue";
    default:
      return "gray";
  }
}

export function JobRow({ job, compact = false }: { job: Job; compact?: boolean }) {
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
  const pct =
    job.progress.total > 0
      ? (job.progress.done / job.progress.total) * 100
      : ACTIVE.includes(job.status)
        ? 100
        : 0;
  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={500}>
          {jobLabel(job)}{" "}
          <Text span c={jobColor(job.status)} size="xs">
            {job.status.replaceAll("_", " ")}
          </Text>
        </Text>
        <Group gap={4}>
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
          {ACTIVE.includes(job.status) && (
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => act("cancel")}>
              Cancel
            </Button>
          )}
        </Group>
      </Group>
      {(ACTIVE.includes(job.status) || !compact) && (
        <Progress
          value={pct}
          size="sm"
          animated={job.status === "running"}
          color={jobColor(job.status)}
        />
      )}
      <Text size="xs" c="dimmed" lineClamp={2}>
        {job.error ?? job.progress.label}
        {job.progress.total > 0 ? ` · ${job.progress.done}/${job.progress.total}` : ""}
        {job.itemErrors > 0 ? ` · ${job.itemErrors} item(s) failed` : ""}
        {job.usage.calls > 0 ? ` · ${job.usage.calls} calls` : ""}
        {job.usage.cost !== null ? ` · $${job.usage.cost.toFixed(3)}` : ""}
      </Text>
    </Stack>
  );
}

export function JobsIndicator() {
  const { data } = useJobs();
  const jobs = data?.jobs ?? [];
  const active = jobs.filter((j) => ACTIVE.includes(j.status));
  const recent = jobs.slice(0, 6);
  return (
    <Popover width={380} position="bottom-end" shadow="md">
      <Popover.Target>
        <Indicator disabled={active.length === 0} label={active.length} size={16} color="blue">
          <Button variant="default" size="xs">
            Jobs
          </Button>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="md">
          {recent.length === 0 && (
            <Text size="sm" c="dimmed">
              No jobs yet.
            </Text>
          )}
          {recent.map((job) => (
            <Stack key={job.id} gap={2}>
              <JobRow job={job} compact />
              <Text
                size="xs"
                component={Link}
                to={`/projects/${job.projectId}`}
                c="dimmed"
                td="underline"
              >
                Open project
              </Text>
            </Stack>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
