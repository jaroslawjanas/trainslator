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
import {
  type Connection,
  type ConnectionKind,
  MASKED,
  protocolOf,
} from "../../../../src/shared/schemas/settings.ts";
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

const BASE_URL_HINT: Record<string, string> = {
  openai: "The OpenAI-compatible endpoint, usually ending in /v1.",
  ollama: "Where Ollama listens on this computer, normally http://localhost:11434.",
  ollama_cloud: "https://ollama.com. Change it only to go through a proxy.",
  anthropic: "https://api.anthropic.com. Change it only to go through a proxy.",
};

/** Plain http to a host on the internet gets redirected to https, and the redirected POST fails. */
function insecureRemote(url: string): boolean {
  const m = /^http:\/\/([^/:]+)/i.exec(url.trim());
  if (!m) return false;
  const host = m[1]!.toLowerCase();
  return !(
    host === "localhost" ||
    host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(host)
  );
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
  const isOllama = c.kind === "ollama" || c.kind === "ollama_cloud";

  /** Switch kind; name, URL and key follow the new kind unless you changed them. */
  const switchKind = (kind: ConnectionKind) => {
    const from = presets[c.kind];
    const to = presets[kind];
    const keyIsDefault =
      c.apiKey.kind === "none"
        ? from.suggestedKeyEnv === null
        : c.apiKey.kind === "env" && c.apiKey.name === from.suggestedKeyEnv;
    set({
      kind,
      name: isNew || c.name === from.label ? to.label : c.name,
      baseUrl: isNew || c.baseUrl === from.defaultBaseUrl ? to.defaultBaseUrl : c.baseUrl,
      apiKey:
        isNew || keyIsDefault
          ? to.suggestedKeyEnv
            ? { kind: "env", name: to.suggestedKeyEnv }
            : { kind: "none" }
          : c.apiKey,
    });
  };

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
          data={Object.entries(presets)
            .filter(([value]) => value !== "ollama_cloud")
            .map(([value, p]) => ({ value, label: value === "ollama" ? "Ollama" : p.label }))}
          value={isOllama ? "ollama" : c.kind}
          allowDeselect={false}
          onChange={(value) => {
            if (!value || (value === "ollama" && isOllama)) return;
            switchKind(value as ConnectionKind);
          }}
        />
        {isOllama && (
          <Stack gap={6}>
            <Text size="sm" fw={500}>
              Where does Ollama run?
            </Text>
            <SegmentedControl
              size="sm"
              value={c.kind}
              onChange={(v) => switchKind(v as ConnectionKind)}
              data={[
                { value: "ollama", label: "On this computer" },
                { value: "ollama_cloud", label: "Ollama Cloud (API)" },
              ]}
            />
          </Stack>
        )}
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
          description={
            BASE_URL_HINT[c.kind] ?? BASE_URL_HINT[protocolOf(c.kind)] ?? BASE_URL_HINT.openai
          }
          value={c.baseUrl}
          onChange={(e) => set({ baseUrl: e.currentTarget.value })}
          error={
            insecureRemote(c.baseUrl)
              ? "This address uses http:// for a server on the internet. Hosted APIs need https://; over http the request is redirected and fails."
              : undefined
          }
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
