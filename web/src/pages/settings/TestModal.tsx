import {
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useState } from "react";
import type { Connection, Model } from "../../../../src/shared/schemas/settings.ts";
import { post } from "../../api/client.ts";
import type { ProbeReport } from "../../api/types.ts";
import { StageMark } from "../../components/StageMark.tsx";

export function TestModal({
  opened,
  connection,
  model,
  onClose,
  onApply,
}: {
  opened: boolean;
  connection: Connection;
  model: Model;
  onClose: () => void;
  onApply: (suggestions: Partial<Model>) => Promise<void>;
}) {
  const [deep, setDeep] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const res = await post<{ report: ProbeReport }>(
        `/api/settings/connections/${connection.id}/test`,
        { modelId: model.id, deep },
      );
      setReport(res.report);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const suggestions = report ? Object.entries(report.suggestions) : [];
  return (
    <Modal opened={opened} onClose={onClose} title={`Test ${model.label}`} size="lg">
      <Stack>
        <Text size="sm">
          Sends {deep ? "about 6" : "2–4"} small requests to check that the model answers, returns
          valid JSON, accepts its parameters and can switch reasoning.
        </Text>
        <Checkbox
          label="Also check long prompts and caching (sends a prompt of up to 24,000 tokens twice)"
          checked={deep}
          onChange={(e) => setDeep(e.currentTarget.checked)}
        />
        <Group>
          <Button onClick={run} loading={running}>
            Run test
          </Button>
          {running && <Loader size="sm" />}
        </Group>
        {error && (
          <Alert color="red" title="The test couldn't run">
            {error}
          </Alert>
        )}
        {report && (
          <Table>
            <Table.Tbody>
              {report.checks.map((c) => (
                <Table.Tr key={c.name}>
                  <Table.Td w={28} style={{ verticalAlign: "top", paddingTop: 12 }}>
                    <StageMark
                      state={c.ok === true ? "done" : c.ok === false ? "attention" : "neutral"}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {c.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {c.detail}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {suggestions.length > 0 && (
          <Alert color="yellow" title="Suggested settings">
            <Stack gap="xs">
              {suggestions.map(([k, v]) => (
                <Text key={k} size="sm">
                  {k}: <Code>{JSON.stringify(v)}</Code>
                </Text>
              ))}
              <Group>
                <Button size="xs" onClick={() => onApply(report!.suggestions)}>
                  Apply suggestions
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
      </Stack>
    </Modal>
  );
}
