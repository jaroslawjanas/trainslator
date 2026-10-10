import { Alert, Badge, Group, Loader, Paper, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { STEP_INFO, type Step } from "../../../../src/shared/steps.ts";
import { get } from "../../api/client.ts";
import type { Usage, UsageResponse } from "../../api/types.ts";

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

function cacheRate(u: Usage): string {
  return u.promptTokens > 0 ? `${Math.round((u.cachedTokens / u.promptTokens) * 100)}%` : "–";
}

export function UsagePanel({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["project", projectId, "usage"],
    queryFn: () => get<UsageResponse>(`/api/usage/${projectId}`),
  });
  if (isLoading) return <Loader />;
  if (error || !data) return <Alert color="red">{(error as Error)?.message}</Alert>;
  const t = data.total;
  return (
    <Stack>
      <SimpleGrid cols={{ base: 2, md: 5 }}>
        {[
          ["Requests", fmt(t.calls)],
          ["Input tokens", fmt(t.promptTokens)],
          ["Cached", `${fmt(t.cachedTokens)} (${cacheRate(t)})`],
          ["Output tokens", fmt(t.completionTokens)],
          ["Cost", t.cost !== null ? `$${t.cost.toFixed(3)}` : "unknown"],
        ].map(([label, value]) => (
          <Paper key={label} withBorder p="sm">
            <Text size="xs" c="dimmed">
              {label}
            </Text>
            <Text fw={600}>{value}</Text>
          </Paper>
        ))}
      </SimpleGrid>
      {t.estimated && (
        <Text size="xs" c="dimmed">
          Some providers didn't report usage; those numbers are estimates.
        </Text>
      )}
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Step</Table.Th>
            <Table.Th>Requests</Table.Th>
            <Table.Th>Input</Table.Th>
            <Table.Th>Cached</Table.Th>
            <Table.Th>Output</Table.Th>
            <Table.Th>Reasoning</Table.Th>
            <Table.Th>Cost</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {Object.entries(data.byStep).map(([step, u]) => (
            <Table.Tr key={step}>
              <Table.Td>{STEP_INFO[step as Step]?.label ?? step}</Table.Td>
              <Table.Td>
                {fmt(u.calls)}
                {u.cacheHits > 0 ? ` (+${u.cacheHits} from cache)` : ""}
              </Table.Td>
              <Table.Td>{fmt(u.promptTokens)}</Table.Td>
              <Table.Td>{cacheRate(u)}</Table.Td>
              <Table.Td>{fmt(u.completionTokens)}</Table.Td>
              <Table.Td>{fmt(u.reasoningTokens)}</Table.Td>
              <Table.Td>{u.cost !== null ? `$${u.cost.toFixed(3)}` : "–"}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text fw={600} size="sm">
        Recent requests
      </Text>
      <Table striped>
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
                  {c.modelName}
                  {c.attempt > 1 ? ` · attempt ${c.attempt}` : ""}
                </Text>
              </Table.Td>
              <Table.Td>
                {c.kind === "cache_hit" ? (
                  <Badge size="xs" variant="light">
                    cache
                  </Badge>
                ) : c.error ? (
                  <Text size="xs" c="red">
                    {c.error}
                  </Text>
                ) : (
                  <Group gap={4}>
                    <Text size="xs">
                      {fmt(c.usage.promptTokens)} in · {fmt(c.usage.completionTokens)} out ·{" "}
                      {(c.latencyMs / 1000).toFixed(1)} s
                    </Text>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
