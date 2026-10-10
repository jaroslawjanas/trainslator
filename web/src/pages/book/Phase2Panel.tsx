import { Accordion, Alert, Badge, Button, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api/client.ts";
import { JobRow, useJobs } from "../../components/JobsIndicator.tsx";
import { costText } from "../pair/Phase1Panel.tsx";
import { useSettings } from "../SettingsPage.tsx";
import type { BookDetail, StepView } from "./types.ts";

interface Estimate {
  steps: number;
  referenceTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export function Phase2Panel({ pid, detail }: { pid: string; detail: BookDetail }) {
  const client = useQueryClient();
  const bookId = detail.book.id;
  const steps = useQuery({
    queryKey: ["target", bookId, "phase2"],
    queryFn: () =>
      get<{ steps: StepView[]; review: { outcomes: StepView["outcomes"] } | null }>(
        `/api/projects/${pid}/books/${bookId}/phase2/steps`,
      ),
  });
  const estimate = useQuery({
    queryKey: ["target", bookId, "phase2-estimate"],
    queryFn: () => get<Estimate>(`/api/projects/${pid}/books/${bookId}/phase2/estimate`),
  });
  const settings = useSettings();
  const jobs = useJobs();
  const job = (jobs.data?.jobs ?? []).find((j) => j.targetId === bookId && j.type === "phase2");
  const running = job && ["queued", "running", "pausing"].includes(job.status);
  const model = settings.data?.settings.models.find(
    (m) => m.id === settings.data?.settings.steps["phase2.chapter"].modelId,
  );

  const start = async (path: string) => {
    try {
      await post(path);
      void client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't start phase 2",
        message: (e as Error).message,
      });
    }
  };

  const counts = (s: StepView) => ({
    applied: s.outcomes.filter((o) => o.result === "applied").length,
    rejected: s.outcomes.filter((o) => o.result === "rejected").length,
    suggestions: s.outcomes.filter((o) => o.result === "suggestion").length,
  });

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Phase 2 reads the book chapter by chapter, before anything is translated. It writes a short
        synopsis of each chapter and builds the book's knowledge base: names, terms and facts with
        proposed translations. Things it can't decide yet become open questions; later chapters (or
        you) answer them. You can answer questions in the knowledge base while it runs.
      </Text>
      {estimate.data && (
        <Card withBorder>
          <Text size="sm">
            {estimate.data.steps} chapters · reference knowledge about{" "}
            {estimate.data.referenceTokens.toLocaleString()} tokens per request · about{" "}
            {estimate.data.inputTokens.toLocaleString()} input tokens (
            {estimate.data.cachedTokens.toLocaleString()} of them cacheable) and{" "}
            {estimate.data.outputTokens.toLocaleString()} output tokens ·{" "}
            {costText(estimate.data.inputTokens, estimate.data.outputTokens, model?.pricing)}
          </Text>
        </Card>
      )}
      {job && <JobRow job={job} />}
      <Group>
        <Button
          disabled={Boolean(running)}
          onClick={() => start(`/api/projects/${pid}/books/${bookId}/phase2/run`)}
        >
          {detail.book.phase2.state === "none" ? "Run phase 2" : "Continue / run again"}
        </Button>
      </Group>
      {steps.isLoading && <Loader />}
      {steps.data && steps.data.steps.length === 0 && (
        <Alert color="gray">No chapters read yet.</Alert>
      )}
      {steps.data && steps.data.steps.length > 0 && (
        <Accordion variant="separated">
          {steps.data.steps.map((s) => {
            const c = counts(s);
            return (
              <Accordion.Item key={s.step} value={String(s.step)}>
                <Accordion.Control>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" fw={500} lineClamp={1}>
                      {s.step + 1}. {s.title}
                      {s.part ? ` (part ${s.part.index + 1}/${s.part.count})` : ""}
                    </Text>
                    <Group gap={4} wrap="nowrap">
                      <Badge size="xs" variant="light" color="green">
                        {c.applied} changes
                      </Badge>
                      {c.suggestions > 0 && (
                        <Badge size="xs" variant="light" color="grape">
                          {c.suggestions} suggestions
                        </Badge>
                      )}
                      {c.rejected > 0 && (
                        <Badge size="xs" variant="light" color="red">
                          {c.rejected} rejected
                        </Badge>
                      )}
                    </Group>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    <Text size="sm">{s.synopsis || "(no synopsis)"}</Text>
                    {s.outcomes.map((o) => (
                      <Text
                        key={`${o.op}:${o.entryId ?? o.id ?? o.source ?? ""}:${o.result}:${o.reason}`}
                        size="xs"
                        c={
                          o.result === "rejected"
                            ? "red"
                            : o.result === "suggestion"
                              ? "grape"
                              : "dimmed"
                        }
                      >
                        {o.op} {o.source ?? o.id ?? ""}: {o.message}
                        {o.reason ? ` — ${o.reason}` : ""}
                      </Text>
                    ))}
                    <Group>
                      <Button
                        size="xs"
                        variant="light"
                        disabled={Boolean(running)}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Re-run phase 2 from "${s.title}"? Later chapters are read again; your own edits are kept.`,
                            )
                          ) {
                            void start(
                              `/api/projects/${pid}/books/${bookId}/phase2/rerun-from/${s.step}`,
                            );
                          }
                        }}
                      >
                        Re-run from here
                      </Button>
                    </Group>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
        </Accordion>
      )}
      {steps.data?.review && (
        <Text size="sm" c="dimmed">
          Final review: {steps.data.review.outcomes.filter((o) => o.result === "applied").length}{" "}
          changes.
        </Text>
      )}
    </Stack>
  );
}
