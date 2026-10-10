import { Alert, Box, Button, Group, Loader, Stack, Table, Tabs, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { Connection, Model, Settings } from "../../../src/shared/schemas/settings.ts";
import { del, get, put } from "../api/client.ts";
import type { SettingsResponse } from "../api/types.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { ConnectionModal } from "./settings/ConnectionModal.tsx";
import { ModelModal } from "./settings/ModelModal.tsx";
import { StepsPanel } from "./settings/StepsPanel.tsx";
import { TestModal } from "./settings/TestModal.tsx";

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => get<SettingsResponse>("/api/settings"),
  });
}

function keyText(c: Connection): string {
  if (c.apiKey.kind === "env") return `the key from ${c.apiKey.name}`;
  if (c.apiKey.kind === "literal") return c.apiKey.value ? "a stored key" : "no key entered yet";
  return "no key";
}

const STRUCTURED_TEXT: Record<Model["structuredOutput"], string> = {
  json_schema: "JSON schema",
  json_object: "JSON mode",
  none: "described in the prompt",
};

export function SettingsPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { section = "connections" } = useParams();
  const { data, isLoading, error } = useSettings();
  const [connModal, setConnModal] = useState<{ open: boolean; initial: Connection | null }>({
    open: false,
    initial: null,
  });
  const [modelModal, setModelModal] = useState<{
    open: boolean;
    connection: Connection | null;
    initial: Model | null;
  }>({
    open: false,
    connection: null,
    initial: null,
  });
  const [testing, setTesting] = useState<{ connection: Connection; model: Model } | null>(null);

  if (isLoading) return <Loader size="sm" mt="xl" />;
  if (error || !data)
    return (
      <Alert color="red" mt="xl">
        {(error as Error)?.message ?? "Couldn't load the settings."}
      </Alert>
    );
  const { settings, presets } = data;

  const update = (s: Settings) =>
    client.setQueryData<SettingsResponse>(["settings"], { ...data, settings: s });
  const run = async (fn: () => Promise<{ settings: Settings }>, message?: string) => {
    try {
      const res = await fn();
      update(res.settings);
      if (message) notifications.show({ color: "green", message });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
      throw e;
    }
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="The AI services Trainslator talks to, and which model does each step. Settings apply to every project."
        actions={
          section === "connections" && (
            <Button onClick={() => setConnModal({ open: true, initial: null })}>
              Add connection
            </Button>
          )
        }
      />
      <Tabs
        value={section}
        onChange={(v) => v && navigate(v === "connections" ? "/settings" : `/settings/${v}`)}
        keepMounted={false}
      >
        <Tabs.List mb="xl">
          <Tabs.Tab value="connections">Connections and models</Tabs.Tab>
          <Tabs.Tab value="steps">Models for each step</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="connections">
          <Box maw={1100}>
            {settings.connections.length === 0 && (
              <Text size="md" c="dimmed" maw={640}>
                No connections yet. Add one for an OpenAI-compatible API (OpenAI, OpenRouter,
                DeepSeek, Ollama, vLLM and others), then add the models you want to use.
              </Text>
            )}
            {settings.connections.map((c) => {
              const models = settings.models.filter((m) => m.connectionId === c.id);
              return (
                <Box key={c.id} mb={48}>
                  <Group justify="space-between" align="flex-end" mb="sm" gap="md">
                    <Box style={{ minWidth: 0 }}>
                      <Text className="serif" fw={600} size="xl">
                        {c.name}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {presets[c.kind].label} at <span className="mono">{c.baseUrl}</span>, using{" "}
                        {keyText(c)}
                        {c.stream ? "" : ", without streaming"}, at most {c.maxParallel} requests at
                        a time.
                      </Text>
                    </Box>
                    <Group gap="xs">
                      <Button
                        variant="subtle"
                        color="red"
                        onClick={() => {
                          if (window.confirm(`Delete ${c.name} and its models?`))
                            void run(
                              () => del(`/api/settings/connections/${c.id}`),
                              "Connection deleted.",
                            );
                        }}
                      >
                        Delete
                      </Button>
                      <Button
                        variant="default"
                        onClick={() => setConnModal({ open: true, initial: c })}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="default"
                        onClick={() => setModelModal({ open: true, connection: c, initial: null })}
                      >
                        Add model
                      </Button>
                    </Group>
                  </Group>
                  {models.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      No models on this connection yet.
                    </Text>
                  ) : (
                    <Table.ScrollContainer minWidth={760}>
                      <Table>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Model</Table.Th>
                            <Table.Th ta="right">Context</Table.Th>
                            <Table.Th ta="right">Output limit</Table.Th>
                            <Table.Th>Structured output</Table.Th>
                            <Table.Th>Reasoning</Table.Th>
                            <Table.Th />
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody className="num">
                          {models.map((m) => (
                            <Table.Tr key={m.id}>
                              <Table.Td>
                                <Text size="md" fw={500}>
                                  {m.label}
                                </Text>
                                <Text size="xs" c="dimmed" className="mono">
                                  {m.modelName}
                                </Text>
                              </Table.Td>
                              <Table.Td ta="right">{m.contextWindow.toLocaleString()}</Table.Td>
                              <Table.Td ta="right">{m.maxOutputTokens.toLocaleString()}</Table.Td>
                              <Table.Td>{STRUCTURED_TEXT[m.structuredOutput]}</Table.Td>
                              <Table.Td>{m.reasoningMode.replaceAll("_", " ")}</Table.Td>
                              <Table.Td>
                                <Group gap={4} justify="flex-end" wrap="nowrap">
                                  <Button
                                    size="compact-sm"
                                    variant="default"
                                    onClick={() => setTesting({ connection: c, model: m })}
                                  >
                                    Test
                                  </Button>
                                  <Button
                                    size="compact-sm"
                                    variant="subtle"
                                    color="gray"
                                    onClick={() =>
                                      setModelModal({ open: true, connection: c, initial: m })
                                    }
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    size="compact-sm"
                                    variant="subtle"
                                    color="red"
                                    onClick={() => {
                                      if (window.confirm(`Delete ${m.label}?`))
                                        void run(
                                          () => del(`/api/settings/models/${m.id}`),
                                          "Model deleted.",
                                        );
                                    }}
                                  >
                                    Delete
                                  </Button>
                                </Group>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  )}
                </Box>
              );
            })}
          </Box>
        </Tabs.Panel>
        <Tabs.Panel value="steps">
          <Stack maw={1100}>
            <StepsPanel settings={settings} steps={data.steps} onSaved={update} />
          </Stack>
        </Tabs.Panel>
      </Tabs>

      <ConnectionModal
        opened={connModal.open}
        initial={connModal.initial}
        presets={presets}
        onClose={() => setConnModal({ open: false, initial: null })}
        onSave={(c) => run(() => put(`/api/settings/connections/${c.id}`, c), "Connection saved.")}
      />
      {modelModal.connection && (
        <ModelModal
          opened={modelModal.open}
          connection={modelModal.connection}
          initial={modelModal.initial}
          preset={presets[modelModal.connection.kind]}
          onClose={() =>
            setModelModal({ open: false, connection: modelModal.connection, initial: null })
          }
          onSave={(m) => run(() => put(`/api/settings/models/${m.id}`, m), "Model saved.")}
        />
      )}
      {testing && (
        <TestModal
          opened
          connection={testing.connection}
          model={testing.model}
          onClose={() => setTesting(null)}
          onApply={async (suggestions) => {
            await run(
              () =>
                put(`/api/settings/models/${testing.model.id}`, {
                  ...testing.model,
                  ...suggestions,
                }),
              "Suggested settings applied.",
            );
            setTesting(null);
          }}
        />
      )}
    </>
  );
}
