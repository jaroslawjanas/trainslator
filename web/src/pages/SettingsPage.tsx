import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Connection, Model, Settings } from "../../../src/shared/schemas/settings.ts";
import { del, get, put } from "../api/client.ts";
import type { SettingsResponse } from "../api/types.ts";
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
  if (c.apiKey.kind === "env") return `key from $${c.apiKey.name}`;
  if (c.apiKey.kind === "literal") return c.apiKey.value ? "key stored" : "no key entered";
  return "no key";
}

export function SettingsPage() {
  const client = useQueryClient();
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

  if (isLoading) return <Loader />;
  if (error || !data)
    return <Alert color="red">{(error as Error)?.message ?? "Couldn't load settings."}</Alert>;
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
    <Stack>
      <Title order={2}>Settings</Title>
      <Tabs defaultValue="connections" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="connections">Connections &amp; models</Tabs.Tab>
          <Tabs.Tab value="steps">Step defaults</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="connections" pt="md">
          <Stack>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Connections are OpenAI-compatible APIs. Each connection can have several models.
              </Text>
              <Button onClick={() => setConnModal({ open: true, initial: null })}>
                Add connection
              </Button>
            </Group>
            {settings.connections.length === 0 && (
              <Alert color="blue" title="No connections yet">
                Add a connection to an OpenAI-compatible API (OpenAI, OpenRouter, DeepSeek, Ollama,
                vLLM …), then add the models you want to use.
              </Alert>
            )}
            {settings.connections.map((c) => {
              const models = settings.models.filter((m) => m.connectionId === c.id);
              return (
                <Card key={c.id} withBorder>
                  <Group justify="space-between" mb="sm">
                    <div>
                      <Group gap="xs">
                        <Text fw={600}>{c.name}</Text>
                        <Badge variant="light" size="sm">
                          {presets[c.kind].label}
                        </Badge>
                      </Group>
                      <Text size="xs" c="dimmed">
                        {c.baseUrl} · {keyText(c)} · {c.stream ? "streaming" : "no streaming"}
                        {c.maxParallel ? ` · max ${c.maxParallel} parallel` : ""}
                      </Text>
                    </div>
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => setModelModal({ open: true, connection: c, initial: null })}
                      >
                        Add model
                      </Button>
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() => setConnModal({ open: true, initial: c })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="xs"
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
                    </Group>
                  </Group>
                  {models.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      No models yet.
                    </Text>
                  ) : (
                    <Table striped>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Model</Table.Th>
                          <Table.Th>Context / output</Table.Th>
                          <Table.Th>Parallel</Table.Th>
                          <Table.Th>JSON</Table.Th>
                          <Table.Th>Reasoning</Table.Th>
                          <Table.Th />
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {models.map((m) => (
                          <Table.Tr key={m.id}>
                            <Table.Td>
                              <Text size="sm" fw={500}>
                                {m.label}
                              </Text>
                              <Text size="xs" c="dimmed" className="mono">
                                {m.modelName}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm">
                                {m.contextWindow.toLocaleString()} /{" "}
                                {m.maxOutputTokens.toLocaleString()}
                              </Text>
                            </Table.Td>
                            <Table.Td>{m.maxParallel}</Table.Td>
                            <Table.Td>
                              <Text size="sm">{m.structuredOutput}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm">{m.reasoningMode.replaceAll("_", " ")}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Group gap={4} justify="flex-end" wrap="nowrap">
                                <Button
                                  size="compact-xs"
                                  variant="light"
                                  onClick={() => setTesting({ connection: c, model: m })}
                                >
                                  Test
                                </Button>
                                <Button
                                  size="compact-xs"
                                  variant="default"
                                  onClick={() =>
                                    setModelModal({ open: true, connection: c, initial: m })
                                  }
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="compact-xs"
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
                  )}
                </Card>
              );
            })}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="steps" pt="md">
          <StepsPanel settings={settings} steps={data.steps} onSaved={update} />
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
              "Suggestions applied.",
            );
            setTesting(null);
          }}
        />
      )}
    </Stack>
  );
}
