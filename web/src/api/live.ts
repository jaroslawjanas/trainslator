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

/**
 * The server sends a keepalive every 10 s. Silence for this long means the
 * stream is dead even if the browser thinks it's open: after a server
 * restart, the dev proxy can keep the old connection open without passing
 * anything on.
 */
const SILENCE_MS = 25_000;

/** Subscribes to server events and keeps queries fresh, reconnecting when the stream dies. */
export function useLiveEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const known = new Map<string, Job>();
    const seed = client.getQueryData<{ jobs: Job[] }>(["jobs"]);
    for (const j of seed?.jobs ?? []) known.set(j.id, j);
    let source: EventSource | null = null;
    let lastSeen = Date.now();
    let opened = false;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      source?.close();
      const s = new EventSource("/api/events");
      source = s;
      lastSeen = Date.now();
      const alive = () => {
        lastSeen = Date.now();
      };
      // A reconnect means the server may have restarted: jobs that were running
      // are now interrupted, and anything shown may be out of date.
      s.addEventListener("open", () => {
        alive();
        if (opened) void client.invalidateQueries();
        opened = true;
      });
      s.addEventListener("hello", alive);
      s.addEventListener("ping", alive);
      s.addEventListener("job", (e) => {
        alive();
        const event = JSON.parse((e as MessageEvent).data) as JobEvent;
        if (event.type !== "job") return;
        onJob(client, event.job, known.get(event.job.id));
        known.set(event.job.id, event.job);
      });
      s.addEventListener("changed", (e) => {
        alive();
        const event = JSON.parse((e as MessageEvent).data) as JobEvent;
        if (event.type !== "changed") return;
        void client.invalidateQueries({ queryKey: ["project", event.projectId] });
        if (event.targetId) void client.invalidateQueries({ queryKey: ["target", event.targetId] });
      });
      // An error status (the proxy's, while the server is down) closes the
      // stream for good; the browser only retries network errors itself.
      s.addEventListener("error", () => {
        if (s.readyState !== EventSource.CLOSED || stopped) return;
        clearTimeout(retry);
        retry = setTimeout(connect, 2000);
      });
    };

    connect();
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > SILENCE_MS) connect();
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(watchdog);
      clearTimeout(retry);
      source?.close();
    };
  }, [client]);
}
