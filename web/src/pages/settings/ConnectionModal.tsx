import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import type { Connection, ConnectionKind } from "../../../../src/shared/schemas/settings.ts";
import { MASKED } from "../../../../src/shared/schemas/settings.ts";
import type { KindPreset } from "../../api/types.ts";
import { newClientId } from "../../components/JsonField.tsx";

export function emptyConnection(kind: ConnectionKind, preset: KindPreset): Connection {
  return {
    id: newClientId("conn"),
    name: preset.label,
    kind,
    baseUrl: preset.defaultBaseUrl,
    apiKey: preset.suggestedKeyEnv
      ? { kind: "env", name: preset.suggestedKeyEnv }
      : { kind: "none" },
    headers: [],
    maxParallel: null,
    timeoutSec: 1800,
    idleTimeoutSec: 600,
    maxRetries: 4,
    stream: true,
  };
}

export function ConnectionModal({
  opened,
  initial,
  presets,
  onClose,
  onSave,
}: {
  opened: boolean;
  initial: Connection | null;
  presets: Record<ConnectionKind, KindPreset>;
  onClose: () => void;
  onSave: (c: Connection) => Promise<void>;
}) {
  const [c, setC] = useState<Connection>(
    () => initial ?? emptyConnection("openai", presets.openai),
  );
  const [saving, setSaving] = useState(false);
  const isNew = initial === null;
  useEffect(() => {
    if (opened) setC(initial ?? emptyConnection("openai", presets.openai));
  }, [opened, initial, presets]);

  const set = (patch: Partial<Connection>) => setC((prev) => ({ ...prev, ...patch }));
  const preset = presets[c.kind];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isNew ? "Add connection" : `Edit ${c.name}`}
      size="lg"
    >
      <Stack>
        <Select
          label="Kind"
          description="Pre-fills sensible defaults for this kind of API."
          data={Object.entries(presets).map(([value, p]) => ({ value, label: p.label }))}
          value={c.kind}
          allowDeselect={false}
          onChange={(value) => {
            if (!value) return;
            const kind = value as ConnectionKind;
            const p = presets[kind];
            set({
              kind,
              name: isNew ? p.label : c.name,
              baseUrl: isNew ? p.defaultBaseUrl : c.baseUrl,
              apiKey: isNew
                ? p.suggestedKeyEnv
                  ? { kind: "env", name: p.suggestedKeyEnv }
                  : { kind: "none" }
                : c.apiKey,
            });
          }}
        />
        <Text size="xs" c="dimmed">
          {preset.notes}
        </Text>
        <TextInput
          label="Name"
          value={c.name}
          onChange={(e) => set({ name: e.currentTarget.value })}
        />
        <TextInput
          label="Base URL"
          description="The OpenAI-compatible endpoint, usually ending in /v1."
          value={c.baseUrl}
          onChange={(e) => set({ baseUrl: e.currentTarget.value })}
        />
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            API key
          </Text>
          <SegmentedControl
            value={c.apiKey.kind}
            onChange={(kind) =>
              set({
                apiKey:
                  kind === "env"
                    ? { kind: "env", name: preset.suggestedKeyEnv ?? "API_KEY" }
                    : kind === "literal"
                      ? { kind: "literal", value: "" }
                      : { kind: "none" },
              })
            }
            data={[
              { value: "env", label: "Environment variable" },
              { value: "literal", label: "Paste key" },
              { value: "none", label: "No key" },
            ]}
          />
          {c.apiKey.kind === "env" && (
            <TextInput
              description="Name of a variable in your .env file or environment."
              value={c.apiKey.name}
              onChange={(e) => set({ apiKey: { kind: "env", name: e.currentTarget.value } })}
            />
          )}
          {c.apiKey.kind === "literal" && (
            <PasswordInput
              description={
                c.apiKey.value === MASKED
                  ? "A key is stored. Leave it as is to keep it."
                  : "Stored in the data folder on this computer."
              }
              value={c.apiKey.value}
              onChange={(e) => set({ apiKey: { kind: "literal", value: e.currentTarget.value } })}
            />
          )}
        </Stack>
        <Stack gap={6}>
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              Extra headers
            </Text>
            <Button
              size="compact-xs"
              variant="light"
              onClick={() =>
                set({ headers: [...c.headers, { name: "", value: "", secret: false }] })
              }
            >
              Add header
            </Button>
          </Group>
          {c.headers.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: header rows have no identity; their order doesn't change while editing
            <Group key={i} gap="xs" wrap="nowrap">
              <TextInput
                placeholder="Name"
                value={h.name}
                onChange={(e) =>
                  set({
                    headers: c.headers.map((x, j) =>
                      j === i ? { ...x, name: e.currentTarget.value } : x,
                    ),
                  })
                }
              />
              <TextInput
                placeholder="Value"
                style={{ flex: 1 }}
                value={h.value}
                onChange={(e) =>
                  set({
                    headers: c.headers.map((x, j) =>
                      j === i ? { ...x, value: e.currentTarget.value } : x,
                    ),
                  })
                }
              />
              <Checkbox
                label="Secret"
                checked={h.secret}
                onChange={(e) =>
                  set({
                    headers: c.headers.map((x, j) =>
                      j === i ? { ...x, secret: e.currentTarget.checked } : x,
                    ),
                  })
                }
              />
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Remove header"
                onClick={() => set({ headers: c.headers.filter((_, j) => j !== i) })}
              >
                ×
              </ActionIcon>
            </Group>
          ))}
        </Stack>
        <Group grow>
          <NumberInput
            label="Max parallel (whole connection)"
            description="Empty = only the per-model limits apply."
            min={1}
            value={c.maxParallel ?? ""}
            onChange={(v) => set({ maxParallel: typeof v === "number" ? v : null })}
          />
          <NumberInput
            label="Retries"
            min={0}
            max={10}
            value={c.maxRetries}
            onChange={(v) => set({ maxRetries: Number(v) || 0 })}
          />
        </Group>
        <Group grow>
          <NumberInput
            label="Time limit per request (s)"
            min={30}
            value={c.timeoutSec}
            onChange={(v) => set({ timeoutSec: Number(v) || 1800 })}
          />
          <NumberInput
            label="Give up after silence (s)"
            min={10}
            value={c.idleTimeoutSec}
            onChange={(v) => set({ idleTimeoutSec: Number(v) || 600 })}
          />
        </Group>
        <Switch
          label="Stream responses"
          description="Recommended: keeps long requests alive and gives usage per call."
          checked={c.stream}
          onChange={(e) => set({ stream: e.currentTarget.checked })}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(c);
                onClose();
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
