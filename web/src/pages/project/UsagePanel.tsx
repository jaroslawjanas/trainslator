import { Alert, Box, Button, Loader, SimpleGrid, Table, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { STEP_INFO, type Step } from "../../../../src/shared/steps.ts";
import { get, post } from "../../api/client.ts";
import type { Project, Usage, UsageResponse } from "../../api/types.ts";
import { PageHeader, Section } from "../../components/PageHeader.tsx";
import { formatDate } from "../../lib/format.ts";

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

function cacheShare(u: Usage): string {
  return u.promptTokens > 0 ? `${Math.round((u.cachedTokens / u.promptTokens) * 100)}%` : "–";
}

function money(cost: number | null): string {
  return cost === null ? "–" : `$${cost.toFixed(cost < 1 ? 3 : 2)}`;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="tr-stat-value">{value}</div>
      <div className="tr-stat-label">{label}</div>
    </div>
  );
}

export function UsagePanel({ project }: { project: Project }) {
  const client = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["project", project.id, "usage"],
    queryFn: () => get<UsageResponse>(`/api/usage/${project.id}`),
  });
  const reset = async () => {
    if (
      !window.confirm(
        "Start the usage counts from zero? Requests sent so far are no longer counted here.",
      )
    )
      return;
    try {
      await post(`/api/usage/${project.id}/reset`);
      void client.invalidateQueries({ queryKey: ["project", project.id, "usage"] });
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't reset the usage",
        message: (e as Error).message,
      });
    }
  };
  return (
    <>
      <PageHeader
        context={project.name}
        contextTo={`/projects/${project.id}`}
        title="Usage"
        description={
          <>
            Every request this project sent to an AI model
            {data?.since ? ` since ${formatDate(data.since)}` : ""}, with the tokens it used. Cached
            tokens are parts of the prompt the provider had already seen and usually charges less
            for.
          </>
        }
        actions={
          <Button
            variant="default"
            onClick={reset}
            disabled={!data || (data.total.calls === 0 && data.recent.length === 0)}
          >
            Reset usage
          </Button>
        }
      />
      {isLoading && <Loader size="sm" />}
      {error && <Alert color="red">{(error as Error).message}</Alert>}
      {data && (
        <Box maw={1100}>
          <SimpleGrid cols={{ base: 2, md: 5 }} spacing="xl" mb={40}>
            <Stat value={fmt(data.total.calls)} label="requests" />
            <Stat value={fmt(data.total.promptTokens)} label="input tokens" />
            <Stat value={cacheShare(data.total)} label="of the input cached" />
            <Stat value={fmt(data.total.completionTokens)} label="output tokens" />
            <Stat
              value={data.total.cost !== null ? money(data.total.cost) : "–"}
              label={data.total.cost !== null ? "cost" : "cost (add prices in Settings)"}
            />
          </SimpleGrid>
          {data.total.estimated && (
            <Text size="xs" c="dimmed" mb="md">
              Some providers didn't report usage; those numbers are estimates.
            </Text>
          )}
          <Section title="By step">
            <Table.ScrollContainer minWidth={720}>
              <Table className="num">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Step</Table.Th>
                    <Table.Th ta="right">Requests</Table.Th>
                    <Table.Th ta="right">Input</Table.Th>
                    <Table.Th ta="right">Cached</Table.Th>
                    <Table.Th ta="right">Output</Table.Th>
                    <Table.Th ta="right">Reasoning</Table.Th>
                    <Table.Th ta="right">Cost</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {Object.entries(data.byStep).map(([step, u]) => (
                    <Table.Tr key={step}>
                      <Table.Td>
                        {STEP_INFO[step as Step]?.label ?? (step === "advisor" ? "Advisor" : step)}
                      </Table.Td>
                      <Table.Td ta="right">
                        {fmt(u.calls)}
                        {u.cacheHits > 0 && (
                          <Text span size="xs" c="dimmed">
                            {" "}
                            + {u.cacheHits} reused
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">{fmt(u.promptTokens)}</Table.Td>
                      <Table.Td ta="right">{cacheShare(u)}</Table.Td>
                      <Table.Td ta="right">{fmt(u.completionTokens)}</Table.Td>
                      <Table.Td ta="right">{fmt(u.reasoningTokens)}</Table.Td>
                      <Table.Td ta="right">{money(u.cost)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Section>
          <Section title="Latest requests">
            <Table.ScrollContainer minWidth={720}>
              <Table className="num">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={90}>Time</Table.Th>
                    <Table.Th>Request</Table.Th>
                    <Table.Th ta="right">Input</Table.Th>
                    <Table.Th ta="right">Output</Table.Th>
                    <Table.Th ta="right">Seconds</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.recent.slice(0, 50).map((c) => (
                    <Table.Tr key={c.id}>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {new Date(c.at).toLocaleTimeString()}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{c.label}</Text>
                        <Text size="xs" c="dimmed">
                          <span className="mono">{c.modelName}</span>
                          {c.attempt > 1 ? `, attempt ${c.attempt}` : ""}
                          {c.kind === "cache_hit" ? ", reused a saved answer" : ""}
                        </Text>
                        {c.error && (
                          <Text size="xs" c="red">
                            {c.error}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        {c.kind === "cache_hit" ? "–" : fmt(c.usage.promptTokens)}
                      </Table.Td>
                      <Table.Td ta="right">
                        {c.kind === "cache_hit" ? "–" : fmt(c.usage.completionTokens)}
                      </Table.Td>
                      <Table.Td ta="right">{(c.latencyMs / 1000).toFixed(1)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Section>
        </Box>
      )}
    </>
  );
}
