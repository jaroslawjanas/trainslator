import { Alert, Button, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api/client.ts";
import { JobRow, useJobs } from "../../components/JobsIndicator.tsx";
import { useSettings } from "../SettingsPage.tsx";
import type { PairDetail } from "./AlignmentPanel.tsx";

interface Estimate {
  units: number;
  inputTokens: number;
  outputTokens: number;
}

export function costText(
  input: number,
  output: number,
  pricing: { inputPerM: number; outputPerM: number } | null | undefined,
): string {
  if (!pricing) return "price unknown (add prices to the model in Settings)";
  const cost = (input * pricing.inputPerM + output * pricing.outputPerM) / 1_000_000;
  return `about $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)} before caching`;
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
  if (pair.isLoading) return <Loader />;
  if (!pair.data) return <Alert color="red">Couldn't load the pair.</Alert>;
  const job = (jobs.data?.jobs ?? []).find((j) => j.targetId === pairId && j.type === "phase1");
  const running = job && ["queued", "running", "pausing"].includes(job.status);
  const state = pair.data.pair.phase1.state;
  const readModel = settings.data?.settings.models.find(
    (m) => m.id === settings.data?.settings.steps["phase1.read"].modelId,
  );

  const run = async () => {
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
    <Stack maw={820}>
      <Text size="sm" c="dimmed">
        Phase 1 reads every included chapter pair (in parallel, with the "Phase 1 · read" model),
        groups what it finds, and merges it into this pair's knowledge base (with the "Phase 1 ·
        merge" model). Chapters already read are reused when you run it again, and your edits to the
        knowledge base are kept.
      </Text>
      {estimate.data && (
        <Card withBorder>
          <Text size="sm">
            {estimate.data.units} chapter pairs · about {estimate.data.inputTokens.toLocaleString()}{" "}
            input and {estimate.data.outputTokens.toLocaleString()} output tokens ·{" "}
            {costText(estimate.data.inputTokens, estimate.data.outputTokens, readModel?.pricing)}
          </Text>
        </Card>
      )}
      {job && <JobRow job={job} />}
      <Group>
        <Button onClick={run} disabled={Boolean(running)}>
          {state === "none" ? "Run phase 1" : "Run phase 1 again"}
        </Button>
        {state !== "none" && pair.data.pair.phase1.entries !== null && (
          <Text size="sm">
            Last result: {pair.data.pair.phase1.entries} knowledge-base entries (
            {state.replaceAll("_", " ")}).
          </Text>
        )}
      </Group>
    </Stack>
  );
}
