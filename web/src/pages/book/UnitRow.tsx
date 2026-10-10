import { Badge, Button, Grid, Group, Paper, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { del, post, put } from "../../api/client.ts";
import { PlaceholderText } from "../../components/PlaceholderText.tsx";
import type { UnitView } from "./types.ts";

const STATUS_COLOR = {
  ok: "green",
  flagged: "red",
  refused: "orange",
  pending: "gray",
  edited: "grape",
} as const;

export function UnitRow({
  pid,
  bookId,
  unit,
  onChanged,
}: {
  pid: string;
  bookId: string;
  unit: UnitView;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(unit.translation ?? "");
  const [instruction, setInstruction] = useState("");
  const [asking, setAsking] = useState(false);
  const base = `/api/projects/${pid}/books/${bookId}/units/${unit.urlKey}`;
  const call = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      notifications.show({ color: "green", message });
      onChanged();
      return true;
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't do that",
        message: (e as Error).message,
      });
      return false;
    }
  };

  return (
    <Paper withBorder p="sm" mb="xs">
      <Grid gap="md">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Stack gap={4}>
            <Group gap={6}>
              <Badge size="xs" variant="outline" color="gray">
                {unit.role}
              </Badge>
              {unit.placeholders.length > 0 && (
                <Text size="xs" c="dimmed">
                  keep:{" "}
                  {unit.placeholders
                    .filter((p) => p.required)
                    .map((p) => `${p.kind}${p.n}`)
                    .join(", ") || "–"}
                </Text>
              )}
            </Group>
            <PlaceholderText text={unit.source} placeholders={unit.placeholders} />
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Stack gap={6}>
            <Group gap={6} justify="space-between">
              <Badge size="xs" variant="light" color={STATUS_COLOR[unit.status]}>
                {unit.status}
              </Badge>
              <Group gap={4}>
                {!editing && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => {
                      setText(unit.translation ?? "");
                      setEditing(true);
                    }}
                  >
                    Edit
                  </Button>
                )}
                <Button size="compact-xs" variant="subtle" onClick={() => setAsking((v) => !v)}>
                  Re-translate
                </Button>
                {unit.status === "flagged" && unit.translation && unit.errors.length === 0 && (
                  <Button
                    size="compact-xs"
                    variant="light"
                    onClick={() => call(() => post(`${base}/accept`), "Accepted.")}
                  >
                    Accept
                  </Button>
                )}
                {unit.status === "edited" && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => call(() => del(`${base}/edit`), "Back to the AI translation.")}
                  >
                    Revert edit
                  </Button>
                )}
              </Group>
            </Group>
            {editing ? (
              <Stack gap={6}>
                <Textarea
                  autosize
                  minRows={2}
                  value={text}
                  onChange={(e) => setText(e.currentTarget.value)}
                  classNames={{ input: "mono" }}
                />
                <Text size="xs" c="dimmed">
                  Keep the placeholders like &lt;g1&gt;…&lt;/g1&gt; and &lt;x2/&gt;; they stand for
                  the formatting.
                </Text>
                <Group gap="xs">
                  <Button
                    size="xs"
                    onClick={async () =>
                      (await call(() => put(base, { text }), "Saved.")) && setEditing(false)
                    }
                  >
                    Save
                  </Button>
                  <Button size="xs" variant="default" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </Group>
              </Stack>
            ) : unit.translation ? (
              <PlaceholderText text={unit.translation} placeholders={unit.placeholders} />
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                Not translated yet.
              </Text>
            )}
            {asking && (
              <Group gap="xs" align="flex-end">
                <TextInput
                  size="xs"
                  style={{ flex: 1 }}
                  placeholder="Optional instruction, e.g. more formal, keep the pun"
                  value={instruction}
                  onChange={(e) => setInstruction(e.currentTarget.value)}
                />
                <Button
                  size="xs"
                  onClick={async () => {
                    if (
                      await call(
                        () => post(`${base}/retranslate`, { instruction: instruction || null }),
                        "Re-translation started.",
                      )
                    )
                      setAsking(false);
                  }}
                >
                  Go
                </Button>
              </Group>
            )}
            {unit.errors.map((e) => (
              <Text key={e} size="xs" c="red">
                {e}
              </Text>
            ))}
            {unit.warnings.map((w) => (
              <Text key={w} size="xs" c="orange">
                {w}
              </Text>
            ))}
          </Stack>
        </Grid.Col>
      </Grid>
    </Paper>
  );
}
