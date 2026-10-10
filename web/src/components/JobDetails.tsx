import { Box, Group, Stack, Table, Text, UnstyledButton } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { JobStage } from "../../../src/shared/schemas/jobs.ts";
import { get } from "../api/client.ts";
import type { Job } from "../api/types.ts";
import { plural } from "../lib/format.ts";
import { ACTIVE_JOB, type MarkState } from "../lib/stages.ts";
import { StageMark } from "./StageMark.tsx";

export interface ActiveCall {
  id: string;
  label: string;
  modelName: string;
  reasoning: { enabled: boolean; effort: string | null };
  attempt: number;
  queuedAt: string;
  sentAt: string | null;
  receivedTokens: number;
}

export interface FinishedCall {
  id: string;
  at: string;
  label: string;
  modelName: string;
  attempt: number;
  kind: "request" | "cache_hit";
  finishReason: string | null;
  latencyMs: number;
  waitMs: number;
  completionTokens: number;
  error: string | null;
}

export interface JobActivity {
  active: ActiveCall[];
  finished: FinishedCall[];
}

/** A job's requests, polled every 2 s while it runs. */
export function useJobActivity(job: Job | undefined) {
  const active = job !== undefined && ACTIVE_JOB.includes(job.status);
  return useQuery({
    queryKey: ["job-activity", job?.id],
    queryFn: () => get<JobActivity>(`/api/jobs/${job!.id}/activity`),
    enabled: job !== undefined,
    refetchInterval: active ? 2000 : false,
  });
}

/** "under 1 s", "38 s", "4 min 12 s", "1 h 3 min". */
export function duration(ms: number): string {
  if (ms > 0 && ms < 1000) return "under 1 s";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function reasoningText(r: ActiveCall["reasoning"]): string {
  if (!r.enabled) return "reasoning off";
  return r.effort ? `reasoning, effort ${r.effort}` : "reasoning on";
}

const STAGE_MARK: Record<JobStage["state"], MarkState> = {
  waiting: "none",
  running: "running",
  done: "done",
  skipped: "neutral",
};

/** Re-renders every second while something is running, so elapsed times tick. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function Stages({
  stages,
  active,
  stopped,
}: {
  stages: JobStage[];
  active: ActiveCall[];
  /** The job ended or stopped: a stage still "running" was cut short. */
  stopped: boolean;
}) {
  const running = active.filter((a) => a.sentAt).length;
  const waiting = active.length - running;
  return (
    <Stack gap={6}>
      {stages.map((st) => (
        <Group key={st.key} gap={10} wrap="nowrap">
          <StageMark state={stopped && st.state === "running" ? "warning" : STAGE_MARK[st.state]} />
          <Text size="sm" fw={st.state === "running" ? 500 : 400} style={{ flex: 1 }}>
            {st.label}
          </Text>
          <Text size="sm" c="dimmed" className="num">
            {st.total > 0
              ? `${st.done} of ${st.total}`
              : st.state === "skipped"
                ? "nothing to do"
                : ""}
            {st.state === "running" && running > 0 ? `, ${running} running` : ""}
            {st.state === "running" && waiting > 0 ? `, ${waiting} waiting for a free slot` : ""}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

function InProgress({ active, now }: { active: ActiveCall[]; now: number }) {
  if (active.length === 0) return null;
  // Requests waiting for a slot are summed up, not listed: there can be dozens.
  const sent = active.filter((a) => a.sentAt);
  const waiting = active.length - sent.length;
  return (
    <Box>
      <Text size="sm" fw={500} mb={4}>
        In progress
      </Text>
      {sent.length > 0 && (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing={6} className="num">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Request</Table.Th>
                <Table.Th>Model</Table.Th>
                <Table.Th ta="right">Time</Table.Th>
                <Table.Th ta="right">Received so far</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sent.map((a) => (
                <Table.Tr key={a.id}>
                  <Table.Td>
                    <Text size="sm">{a.label}</Text>
                    {a.attempt > 1 && (
                      <Text size="xs" c="yellow">
                        attempt {a.attempt}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" className="mono">
                      {a.modelName}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {reasoningText(a.reasoning)}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm">{duration(now - Date.parse(a.sentAt ?? a.queuedAt))}</Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" c={a.receivedTokens > 0 ? undefined : "dimmed"}>
                      {a.receivedTokens > 0
                        ? `about ${a.receivedTokens.toLocaleString()} tokens`
                        : "nothing yet"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {waiting > 0 && (
        <Text size="xs" c="dimmed" mt={4}>
          {waiting === 1 ? "1 more request is" : `${waiting.toLocaleString()} more requests are`}{" "}
          waiting for a free slot. How many run at once is the connection's "Max parallel requests"
          setting.
        </Text>
      )}
    </Box>
  );
}

function resultText(c: FinishedCall): { text: string; color?: string } {
  if (c.kind === "cache_hit") return { text: "reused a saved answer", color: "dimmed" };
  if (c.error) return { text: c.error, color: "red" };
  if (c.finishReason === "length") return { text: "cut off at the output limit", color: "yellow" };
  return { text: "ok", color: "dimmed" };
}

function Finished({ finished }: { finished: FinishedCall[] }) {
  const [open, setOpen] = useState(false);
  if (finished.length === 0) return null;
  const problems = finished.filter((c) => c.error).length;
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Group gap={4}>
          <IconChevronRight
            size={14}
            style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
          />
          <Text size="sm" fw={500}>
            Finished requests ({finished.length.toLocaleString()}
            {problems > 0 ? `, ${plural(problems, "had a problem", "had problems")}` : ""})
          </Text>
        </Group>
      </UnstyledButton>
      {open && (
        <Table.ScrollContainer minWidth={720} mt={6}>
          <Table verticalSpacing={6} className="num">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={84}>Finished</Table.Th>
                <Table.Th>Request</Table.Th>
                <Table.Th ta="right">Took</Table.Th>
                <Table.Th ta="right">Waited</Table.Th>
                <Table.Th ta="right">Output tokens</Table.Th>
                <Table.Th>Result</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {finished.map((c) => {
                const r = resultText(c);
                return (
                  <Table.Tr key={c.id}>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {new Date(Date.parse(c.at) + c.latencyMs).toLocaleTimeString()}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{c.label}</Text>
                      {c.attempt > 1 && (
                        <Text size="xs" c="dimmed">
                          attempt {c.attempt}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      {c.kind === "cache_hit" ? "–" : duration(c.latencyMs)}
                    </Table.Td>
                    <Table.Td ta="right">{c.waitMs > 500 ? duration(c.waitMs) : "–"}</Table.Td>
                    <Table.Td ta="right">
                      {c.kind === "cache_hit" ? "–" : c.completionTokens.toLocaleString()}
                    </Table.Td>
                    <Table.Td maw={360}>
                      <Text size="xs" c={r.color} lineClamp={2}>
                        {r.text}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Box>
  );
}

/**
 * What a job is doing: its stages, the requests in flight (how long they
 * have run and how much has arrived), recent messages, and every finished
 * request with its time, size and outcome.
 */
export function JobDetails({ job }: { job: Job }) {
  const activity = useJobActivity(job);
  const running = ACTIVE_JOB.includes(job.status);
  const active = activity.data?.active ?? [];
  const now = useTick(running && active.length > 0);
  const notes = job.notes.slice(-6).reverse();
  const finished = activity.data?.finished ?? [];
  if (
    activity.data &&
    job.progress.stages.length === 0 &&
    notes.length === 0 &&
    finished.length === 0 &&
    active.length === 0
  )
    return (
      <Text size="sm" c="dimmed">
        No details were recorded for this run. Runs started from now on keep them.
      </Text>
    );
  return (
    <Stack gap="md">
      {job.progress.stages.length > 0 && (
        <Stages stages={job.progress.stages} active={active} stopped={!running} />
      )}
      {running && <InProgress active={active} now={now} />}
      {notes.length > 0 && (
        <Box>
          <Text size="sm" fw={500} mb={4}>
            Messages
          </Text>
          <Stack gap={2}>
            {notes.map((n) => (
              <Text key={`${n.at}:${n.message}`} size="xs">
                <Text span c="dimmed" size="xs" className="num">
                  {new Date(n.at).toLocaleTimeString()}
                </Text>{" "}
                {n.message}
              </Text>
            ))}
          </Stack>
        </Box>
      )}
      <Finished finished={finished} />
    </Stack>
  );
}
