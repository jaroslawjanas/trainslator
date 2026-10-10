import { notifications } from "@mantine/notifications";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Job, JobEvent } from "../../../src/shared/schemas/jobs.ts";

const JOB_LABELS: Record<Job["type"], string> = {
  "language-notes": "Language notes",
  phase1: "Phase 1",
  phase2: "Phase 2",
  phase3: "Translation",
  retranslate: "Re-translation",
  build: "Build",
};

export function jobLabel(job: Job): string {
  return JOB_LABELS[job.type] ?? job.type;
}

function onJob(client: QueryClient, job: Job, previous: Job | undefined): void {
  client.setQueryData<{ jobs: Job[] }>(["jobs"], (old) => {
    const list = old?.jobs ?? [];
    const others = list.filter((j) => j.id !== job.id);
    return { jobs: [job, ...others] };
  });
  const finished = ["done", "done_with_errors", "failed", "cancelled", "paused"].includes(
    job.status,
  );
  if (finished && previous && previous.status !== job.status) {
    const color =
      job.status === "done"
        ? "green"
        : job.status === "failed"
          ? "red"
          : job.status === "done_with_errors"
            ? "yellow"
            : "gray";
    notifications.show({
      color,
      title: `${jobLabel(job)}: ${job.status.replaceAll("_", " ")}`,
      message: job.error ?? job.progress.label,
      autoClose: job.status === "failed" ? false : 6000,
    });
    void client.invalidateQueries({ queryKey: ["project", job.projectId] });
  }
}

/** Subscribes to server events and keeps queries fresh. */
export function useLiveEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource("/api/events");
    const known = new Map<string, Job>();
    const seed = client.getQueryData<{ jobs: Job[] }>(["jobs"]);
    for (const j of seed?.jobs ?? []) known.set(j.id, j);
    source.addEventListener("job", (e) => {
      const event = JSON.parse((e as MessageEvent).data) as JobEvent;
      if (event.type !== "job") return;
      onJob(client, event.job, known.get(event.job.id));
      known.set(event.job.id, event.job);
    });
    source.addEventListener("changed", (e) => {
      const event = JSON.parse((e as MessageEvent).data) as JobEvent;
      if (event.type !== "changed") return;
      void client.invalidateQueries({ queryKey: ["project", event.projectId] });
      if (event.targetId) void client.invalidateQueries({ queryKey: ["target", event.targetId] });
    });
    return () => source.close();
  }, [client]);
}
