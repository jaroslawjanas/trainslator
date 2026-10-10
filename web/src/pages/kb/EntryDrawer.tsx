import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { KB_KINDS, KB_TREATMENTS, type KbEntry } from "../../../../src/shared/schemas/kb.ts";

export function EntryDrawer({
  entry,
  isNew,
  onClose,
  onSave,
  onUnlock,
  onDelete,
}: {
  entry: KbEntry | null;
  isNew: boolean;
  onClose: () => void;
  onSave: (e: KbEntry) => Promise<void>;
  onUnlock: (e: KbEntry) => Promise<void>;
  onDelete: (e: KbEntry) => Promise<void>;
}) {
  const [e, setE] = useState<KbEntry | null>(entry);
  const [busy, setBusy] = useState(false);
  useEffect(() => setE(entry), [entry]);
  if (!e) return null;
  const set = (patch: Partial<KbEntry>) => setE((prev) => (prev ? { ...prev, ...patch } : prev));
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      opened={entry !== null}
      onClose={onClose}
      position="right"
      size="lg"
      title={isNew ? "New entry" : e.source}
    >
      <Stack>
        {!isNew && (
          <Group gap="xs">
            <Badge
              color={e.status === "locked" ? "grape" : e.status === "open" ? "orange" : "gray"}
              variant="light"
            >
              {e.status}
            </Badge>
            <Badge variant="outline" color="gray">
              from {e.origin}
            </Badge>
            {e.refs.length > 0 && (
              <Text size="xs" c="dimmed">
                seen in {e.refs.length} chapter{e.refs.length === 1 ? "" : "s"}
              </Text>
            )}
          </Group>
        )}
        {e.status === "open" && e.question && (
          <Alert color="orange" title="Open question">
            {e.question}
          </Alert>
        )}
        <Text size="xs" c="dimmed">
          Saving locks the entry: later automatic runs keep it exactly as you set it.
        </Text>
        <Group grow>
          <Select
            label="Kind"
            data={[...KB_KINDS]}
            value={e.kind}
            allowDeselect={false}
            onChange={(v) => v && set({ kind: v as KbEntry["kind"] })}
          />
          <Select
            label="Treatment"
            data={[...KB_TREATMENTS]}
            value={e.treatment}
            clearable
            onChange={(v) => set({ treatment: (v as KbEntry["treatment"]) ?? null })}
          />
        </Group>
        <TextInput
          label="English"
          value={e.source}
          onChange={(x) => set({ source: x.currentTarget.value })}
        />
        <TagsInput
          label="Also written as (aliases)"
          value={e.aliases}
          onChange={(v) => set({ aliases: v })}
        />
        <TextInput
          label="Translation (dictionary form)"
          value={e.target ?? ""}
          onChange={(x) => set({ target: x.currentTarget.value || null })}
        />
        <TagsInput
          label="Other forms seen"
          value={e.targetSeen}
          onChange={(v) => set({ targetSeen: v })}
        />
        <Stack gap={6}>
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              Facts (attributes)
            </Text>
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => set({ attributes: [...e.attributes, { key: "", value: "" }] })}
            >
              Add
            </Button>
          </Group>
          {e.attributes.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: attribute rows have no identity
            <Group key={i} gap="xs" wrap="nowrap">
              <TextInput
                placeholder="e.g. gender"
                value={a.key}
                onChange={(x) =>
                  set({
                    attributes: e.attributes.map((y, j) =>
                      j === i ? { ...y, key: x.currentTarget.value } : y,
                    ),
                  })
                }
              />
              <TextInput
                placeholder="e.g. female"
                style={{ flex: 1 }}
                value={a.value}
                onChange={(x) =>
                  set({
                    attributes: e.attributes.map((y, j) =>
                      j === i ? { ...y, value: x.currentTarget.value } : y,
                    ),
                  })
                }
              />
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Remove"
                onClick={() => set({ attributes: e.attributes.filter((_, j) => j !== i) })}
              >
                ×
              </ActionIcon>
            </Group>
          ))}
        </Stack>
        <Textarea
          label="Note"
          autosize
          minRows={2}
          value={e.note}
          onChange={(x) => set({ note: x.currentTarget.value })}
        />
        {e.examples.length > 0 && (
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Examples
            </Text>
            {e.examples.map((x, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              <Text key={i} size="sm" c="dimmed">
                “{x.source}”{x.target ? ` → “${x.target}”` : ""}
              </Text>
            ))}
          </Stack>
        )}
        <Group justify="space-between" mt="md">
          <Group gap="xs">
            {!isNew && (
              <Button
                variant="subtle"
                color="red"
                loading={busy}
                onClick={() =>
                  window.confirm("Delete this entry? Automatic runs won't add it back.") &&
                  act(() => onDelete(e))
                }
              >
                Delete
              </Button>
            )}
            {!isNew && e.status === "locked" && (
              <Button variant="default" loading={busy} onClick={() => act(() => onUnlock(e))}>
                Unlock
              </Button>
            )}
          </Group>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!e.source.trim()} onClick={() => act(() => onSave(e))}>
              {e.status === "open" ? "Answer and lock" : "Save and lock"}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Drawer>
  );
}
