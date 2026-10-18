import { Alert, Anchor, Loader, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { get, post } from "../../api/client.ts";
import { useJobs } from "../../components/JobsIndicator.tsx";
import { ModelNote } from "../../components/ModelNote.tsx";
import { estimateText, onSubscription, RunPanel } from "../../components/RunPanel.tsx";
import { displayTitle, plural } from "../../lib/format.ts";
import { useSettings } from "../SettingsPage.tsx";
import type { PairDetail } from "./AlignmentPanel.tsx";
import { Phase1Chapters } from "./Phase1Chapters.tsx";

interface Estimate {
  units: number;
  inputTokens: number;
  outputTokens: number;
}

export function Phase1Panel({ pid, pairId }: { pid: string; pairId: string }) {
  const client = useQueryClient();
  const pair = useQuery({
    queryKey: ["pair", pairId],
    queryFn: () => get<PairDetail>(`/api/projects/${pid}/pairs/${pairId}`),
  });
  const estimate = useQuery({
    queryKey: ["pair", pairId, "estimate"],
    queryFn: () => get<Estimate>(`/api/projects/${pid}/pairs/${pairId}/phase1/estimate`),
  });
  const settings = useSettings();
  const jobs = useJobs();
  if (pair.isLoading) return <Loader size="sm" />;
  if (!pair.data) return <Alert color="red">Couldn't load the pair.</Alert>;
  const job = (jobs.data?.jobs ?? []).find((j) => j.targetId === pairId && j.type === "phase1");
  const { phase1, fromBook } = pair.data.pair;
  const confirmed = pair.data.alignment.status === "confirmed";
  const readModel = settings.data?.settings.models.find(
    (m) => m.id === settings.data?.settings.steps["phase1.read"].modelId,
  );

  const run = async () => {
    if (
      fromBook &&
      phase1.entries !== null &&
      !window.confirm(
        "Learn from this pair? The knowledge base that came from the book is replaced with what the AI learns from the two EPUBs. Your own changes are kept.",
      )
    )
      return;
    try {
      await post(`/api/projects/${pid}/pairs/${pairId}/phase1/run`);
      void client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't start phase 1",
        message: (e as Error).message,
      });
    }
  };

  return (
    <>
      {fromBook && (
        <Alert color="gray" mb="lg" maw={720}>
          Made from the book “{displayTitle(fromBook.title)}”: its knowledge base is the book's, so
          there's nothing to learn first. Learning again replaces it with what the AI finds by
          comparing the two EPUBs; your own changes are kept.
        </Alert>
      )}
      {!confirmed && (
        <Alert color="yellow" mb="lg" maw={720}>
          Confirm the{" "}
          <Anchor component={Link} to={`/projects/${pid}/pairs/${pairId}/alignment`}>
            chapter alignment
          </Anchor>{" "}
          first, so the AI compares the right chapters.
        </Alert>
      )}
      <RunPanel
        state={phase1.state}
        finishedAt={phase1.finishedAt}
        job={job}
        summary={
          phase1.entries !== null ? (
            <>
              The knowledge base has {plural(phase1.entries, "entry", "entries")}.{" "}
              <Anchor component={Link} to={`/projects/${pid}/pairs/${pairId}/kb`} size="sm">
                Review it
              </Anchor>
            </>
          ) : undefined
        }
        estimate={
          estimate.data && phase1.state === "none"
            ? `${plural(estimate.data.units, "chapter pair")} to read. ${estimateText({
                input: estimate.data.inputTokens,
                output: estimate.data.outputTokens,
                pricing: readModel?.pricing,
                subscription: onSubscription(settings.data?.settings, readModel?.id),
              })}`
            : undefined
        }
        actionLabel={phase1.state === "none" ? "Learn from this pair" : "Learn again"}
        disabled={!confirmed}
        onRun={run}
      >
        <ModelNote steps={["phase1.read", "phase1.merge"]} />
      </RunPanel>
      <Text size="sm" c="dimmed" maw={720} mb={40}>
        Chapter pairs are read in parallel, then their findings are merged into one knowledge base.
        Chapters already read are reused when you run it again, and your edits to the knowledge base
        are kept.
      </Text>
      {confirmed && <Phase1Chapters pid={pid} pairId={pairId} job={job} />}
    </>
  );
}
