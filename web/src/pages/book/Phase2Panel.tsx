import { Accordion, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { useJobs } from "../../components/JobsIndicator.tsx";
import { ModelNote } from "../../components/ModelNote.tsx";
import { Section } from "../../components/PageHeader.tsx";
import { estimateText, onSubscription, RunPanel } from "../../components/RunPanel.tsx";
import { displayTitle, plural } from "../../lib/format.ts";
import { ACTIVE_JOB } from "../../lib/stages.ts";
import { useSettings } from "../SettingsPage.tsx";
import { RebuildModal } from "./RebuildModal.tsx";
import type { BookDetail, StepView } from "./types.ts";

interface Estimate {
  steps: number;
  referenceTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

const OP_TEXT: Record<string, string> = {
  add: "Added",
  update: "Updated",
  resolve: "Resolved",
  remove: "Removed",
};

function countText(s: StepView): { text: string; rejected: number; suggestions: number } {
  const applied = s.outcomes.filter((o) => o.result === "applied").length;
  const rejected = s.outcomes.filter((o) => o.result === "rejected").length;
  const suggestions = s.outcomes.filter((o) => o.result === "suggestion").length;
  return { text: plural(applied, "change"), rejected, suggestions };
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
  const running = job !== undefined && ACTIVE_JOB.includes(job.status);
  const model = settings.data?.settings.models.find(
    (m) => m.id === settings.data?.settings.steps["phase2.chapter"].modelId,
  );
  const state = detail.book.phase2.state;
  const finished = state === "done" || state === "done_with_errors";
  const [rebuilding, setRebuilding] = useState(false);

  const start = async (path: string, body?: unknown) => {
    try {
      await post(path, body);
      void client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't start phase 2",
        message: (e as Error).message,
      });
    }
  };

  const list = steps.data?.steps ?? [];
  const costText = estimate.data
    ? estimateText({
        input: estimate.data.inputTokens,
        cached: estimate.data.cachedTokens,
        output: estimate.data.outputTokens,
        pricing: model?.pricing,
        subscription: onSubscription(settings.data?.settings, model?.id),
      })
    : null;
  const reviewChanges =
    steps.data?.review?.outcomes.filter((o) => o.result === "applied").length ?? null;

  return (
    <>
      <RunPanel
        state={state}
        finishedAt={detail.book.phase2.finishedAt}
        job={job}
        summary={
          list.length > 0
            ? `Read ${plural(list.length, "chapter")}${reviewChanges !== null ? `; the final review made ${plural(reviewChanges, "change")}` : ""}. You can answer open questions in the knowledge base.`
            : undefined
        }
        estimate={
          estimate.data && state === "none"
            ? `${plural(estimate.data.steps, "chapter")} to read, with about ${estimate.data.referenceTokens.toLocaleString()} tokens of reference knowledge in each request. ${costText}`
            : undefined
        }
        actionLabel={
          state === "none"
            ? "Read the book"
            : finished
              ? "Run the final review again"
              : "Continue reading"
        }
        onRun={() =>
          start(
            `/api/projects/${pid}/books/${bookId}/phase2/run`,
            finished ? { again: true } : undefined,
          )
        }
        extra={
          state !== "none" &&
          !running && (
            <Button variant="default" onClick={() => setRebuilding(true)}>
              Read the whole book again
            </Button>
          )
        }
      >
        <ModelNote steps={["phase2.chapter", "phase2.review"]} />
      </RunPanel>
      <RebuildModal
        pid={pid}
        bookId={bookId}
        opened={rebuilding}
        costText={costText}
        onClose={() => setRebuilding(false)}
        onConfirm={(dropOwn) =>
          start(`/api/projects/${pid}/books/${bookId}/phase2/rebuild`, { dropOwn })
        }
      />
      <Section
        title="Chapters"
        description="What the AI noted in each chapter. Open a chapter to see the changes it made to the knowledge base."
      >
        {steps.isLoading && <Loader size="sm" />}
        {steps.data && list.length === 0 && (
          <Text size="md" c="dimmed">
            No chapters read yet.
          </Text>
        )}
        {list.length > 0 && (
          <Accordion
            variant="default"
            chevronPosition="left"
            styles={{
              item: { borderColor: "var(--tr-rule)" },
              control: { paddingLeft: 4 },
              content: { paddingLeft: 36 },
            }}
          >
            {list.map((s) => {
              const c = countText(s);
              return (
                <Accordion.Item key={s.step} value={String(s.step)}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap" gap="md">
                      <Box style={{ minWidth: 0 }}>
                        <Text className="serif" fw={600} size="lg" lineClamp={1}>
                          {displayTitle(s.title)}
                          {s.part ? (
                            <Text span fw={400} c="dimmed" size="md">
                              {" "}
                              part {s.part.index + 1} of {s.part.count}
                            </Text>
                          ) : null}
                        </Text>
                        <Text size="sm" c="dimmed" lineClamp={2} className="serif" mt={2}>
                          {s.synopsis || "No synopsis."}
                        </Text>
                      </Box>
                      <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                        {c.text}
                        {c.rejected > 0 && (
                          <Text span size="sm" c="red">
                            , {c.rejected} rejected
                          </Text>
                        )}
                      </Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm" maw={820}>
                      <Text className="tr-prose" size="md">
                        {s.synopsis || "No synopsis."}
                      </Text>
                      {c.suggestions > 0 && (
                        <Text size="sm" c="blue">
                          {plural(c.suggestions, "suggestion")} for entries you locked; open the
                          knowledge base to see them.
                        </Text>
                      )}
                      <Stack gap={4}>
                        {s.outcomes.map((o) => (
                          <Text
                            key={`${o.op}:${o.entryId ?? o.id ?? o.source ?? ""}:${o.result}:${o.reason}`}
                            size="sm"
                            c={
                              o.result === "rejected"
                                ? "red"
                                : o.result === "suggestion"
                                  ? "blue"
                                  : undefined
                            }
                          >
                            <Text span fw={500}>
                              {OP_TEXT[o.op] ?? o.op}
                            </Text>{" "}
                            <span className="serif">{o.source ?? o.id ?? ""}</span>
                            <Text span c="dimmed" size="sm">
                              {o.result === "applied" && o.message !== "added"
                                ? `, ${o.message}`
                                : ""}
                              {o.result !== "applied" ? `: ${o.message}` : ""}
                              {o.reason ? `. ${o.reason}` : ""}
                            </Text>
                          </Text>
                        ))}
                      </Stack>
                      <Group>
                        <Button
                          size="xs"
                          variant="default"
                          disabled={running}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Read the book again from "${displayTitle(s.title)}"? That chapter and the later ones are read anew, with fresh answers from the models; your own changes are kept.`,
                              )
                            ) {
                              void start(
                                `/api/projects/${pid}/books/${bookId}/phase2/rerun-from/${s.step}`,
                              );
                            }
                          }}
                        >
                          Read again from this chapter
                        </Button>
                      </Group>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        )}
      </Section>
    </>
  );
}
