import { notifications } from "@mantine/notifications";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Job, JobEvent } from "../../../src/shared/schemas/jobs.ts";

const JOB_LABELS: Record<Job["type"], string> = {
  "language-notes": "Language notes",
  phase1: "Phase 1: learning",
  phase2: "Phase 2: reading",
  phase3: "Phase 3: translation",
  retranslate: "Translating again",
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
  // When a job starts or stops, the pages about its book or pair must reload
  // (e.g. "Not run yet" becomes "Done").
  if (previous?.status !== job.status) {
    void client.invalidateQueries({ queryKey: ["project", job.projectId] });
    void client.invalidateQueries({ queryKey: ["pair", job.targetId] });
    void client.invalidateQueries({ queryKey: ["book", job.targetId] });
    void client.invalidateQueries({ queryKey: ["target", job.targetId] });
    void client.invalidateQueries({ queryKey: ["job-activity", job.id] });
  }
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
    // A reconnect means the server may have restarted: jobs that were running
    // are now interrupted, and anything shown may be out of date.
    let opened = false;
    source.addEventListener("open", () => {
      if (opened) void client.invalidateQueries();
      opened = true;
    });
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
