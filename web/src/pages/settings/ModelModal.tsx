import {
  Autocomplete,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  type Connection,
  type Model,
  protocolOf,
} from "../../../../src/shared/schemas/settings.ts";
import { get } from "../../api/client.ts";
import type { KindPreset, ListedModel } from "../../api/types.ts";
import { JsonField, newClientId } from "../../components/JsonField.tsx";

export function emptyModel(connection: Connection, preset: KindPreset): Model {
  return {
    id: newClientId("model"),
    connectionId: connection.id,
    modelName: "",
    label: "",
    contextWindow: preset.limits.contextWindow,
    maxOutputTokens: preset.limits.maxOutputTokens,
    maxParallel: 4,
    pricing: null,
    ...preset.model,
  };
}

export function ModelModal({
  opened,
  connection,
  initial,
  preset,
  onClose,
  onSave,
}: {
  opened: boolean;
  connection: Connection;
  initial: Model | null;
  preset: KindPreset;
  onClose: () => void;
  onSave: (m: Model) => Promise<void>;
}) {
  const [m, setM] = useState<Model>(() => initial ?? emptyModel(connection, preset));
  const [jsonOk, setJsonOk] = useState({ on: true, off: true });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (opened) setM(initial ?? emptyModel(connection, preset));
  }, [opened, initial, connection, preset]);
  const set = (patch: Partial<Model>) => setM((prev) => ({ ...prev, ...patch }));

  const listed = useQuery({
    queryKey: ["models", connection.id],
    queryFn: () =>
      get<{ models: ListedModel[] }>(`/api/settings/connections/${connection.id}/models`),
    enabled: opened,
    retry: false,
    staleTime: 60_000,
  });
  const options = listed.data?.models ?? [];

  const pick = (name: string) => {
    const found = options.find((o) => o.id === name);
    set({
      modelName: name,
      label: m.label || name,
      ...(found?.contextWindow ? { contextWindow: found.contextWindow } : {}),
      ...(found?.maxOutputTokens ? { maxOutputTokens: found.maxOutputTokens } : {}),
      ...(found?.pricing ? { pricing: found.pricing } : {}),
    });
  };

  const valid = m.modelName.trim() && m.label.trim() && jsonOk.on && jsonOk.off;
  const protocol = protocolOf(connection.kind);
  const nameHint =
    protocol === "anthropic"
      ? "e.g. claude-opus-5-5."
      : connection.kind === "ollama"
        ? "A model installed in Ollama, e.g. qwen3:14b."
        : connection.kind === "ollama_cloud"
          ? "As Ollama Cloud lists it, e.g. gpt-oss:120b (no :cloud suffix)."
          : "As the API expects it, e.g. gpt-5-mini.";

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={initial ? `Edit ${initial.label}` : `Add a model to ${connection.name}`}
      size="lg"
    >
      <Stack>
        <Autocomplete
          label="Model name"
          description={listed.isError ? "Couldn't list models; type the name." : nameHint}
          data={options.map((o) => o.id)}
          value={m.modelName}
          limit={50}
          onChange={(v) => set({ modelName: v })}
          onOptionSubmit={pick}
        />
        <TextInput
          label="Label"
          description="Shown in the app."
          value={m.label}
          onChange={(e) => set({ label: e.currentTarget.value })}
        />
        <Group grow>
          <NumberInput
            label="Context window (tokens)"
            description={
              connection.kind === "ollama"
                ? "Ollama sets aside memory for this many tokens."
                : undefined
            }
            min={1000}
            step={1000}
            thousandSeparator=","
            value={m.contextWindow}
            onChange={(v) => set({ contextWindow: Number(v) || 8000 })}
          />
          <NumberInput
            label="Max output (tokens)"
            min={256}
            step={1000}
            thousandSeparator=","
            value={m.maxOutputTokens}
            onChange={(v) => set({ maxOutputTokens: Number(v) || 4000 })}
          />
          <NumberInput
            label="Max parallel requests"
            description="Your provider's rate limit."
            min={1}
            max={64}
            value={m.maxParallel}
            onChange={(v) => set({ maxParallel: Number(v) || 1 })}
          />
        </Group>
        <Divider label="How the API behaves" labelPosition="left" />
        <Group grow>
          <Select
            label="JSON output"
            data={[
              { value: "json_schema", label: "JSON schema (strict)" },
              { value: "json_object", label: "JSON mode" },
              { value: "none", label: "Described in the prompt only" },
            ]}
            value={m.structuredOutput}
            allowDeselect={false}
            onChange={(v) => v && set({ structuredOutput: v as Model["structuredOutput"] })}
          />
          {protocol === "openai" && (
            <Select
              label="Length parameter"
              data={["max_tokens", "max_completion_tokens"]}
              value={m.maxTokensParam}
              allowDeselect={false}
              onChange={(v) => v && set({ maxTokensParam: v as Model["maxTokensParam"] })}
            />
          )}
        </Group>
        <Group grow>
          <Select
            label="Reasoning"
            data={[
              { value: "optional", label: "Optional (off unless enabled)" },
              { value: "on_by_default", label: "On by default" },
              { value: "mandatory", label: "Always on" },
            ]}
            value={m.reasoningMode}
            allowDeselect={false}
            onChange={(v) => v && set({ reasoningMode: v as Model["reasoningMode"] })}
          />
          <Switch
            label="Send temperature"
            description="Many reasoning models reject it."
            checked={m.sendTemperature}
            onChange={(e) => set({ sendTemperature: e.currentTarget.checked })}
          />
        </Group>
        <JsonField
          label="Reasoning on (added to the request)"
          description={
            protocol === "ollama"
              ? 'Ollama: {"think": true}, or {"think": "{{effort}}"} for gpt-oss models.'
              : protocol === "anthropic"
                ? 'Anthropic: {"thinking": {"type": "adaptive"}, "output_config": {"effort": "{{effort}}"}}.'
                : '{{effort}} and {{budget}} are replaced with the step settings, e.g. {"reasoning_effort": "{{effort}}"}.'
          }
          value={m.reasoningTemplates.onEnabled}
          onChange={(v, ok) => {
            setJsonOk((s) => ({ ...s, on: ok }));
            if (ok) set({ reasoningTemplates: { ...m.reasoningTemplates, onEnabled: v } });
          }}
        />
        <JsonField
          label="Reasoning off (added to the request)"
          description={
            protocol === "ollama"
              ? 'Ollama: {"think": false}. Empty = send nothing.'
              : protocol === "anthropic"
                ? "Empty = the model's own default. Current Claude models think unless told otherwise, and some can't turn it off."
                : 'e.g. {"reasoning_effort": "none"}. Empty = send nothing.'
          }
          value={m.reasoningTemplates.onDisabled}
          onChange={(v, ok) => {
            setJsonOk((s) => ({ ...s, off: ok }));
            if (ok) set({ reasoningTemplates: { ...m.reasoningTemplates, onDisabled: v } });
          }}
        />
        {protocol === "anthropic" && (
          <Group grow>
            <Select
              label="Prompt caching"
              description="Marks the stable parts of each request for caching."
              data={[
                { value: "anthropic", label: "On" },
                { value: "none", label: "Off" },
              ]}
              value={m.cacheMarkers}
              allowDeselect={false}
              onChange={(v) => v && set({ cacheMarkers: v as Model["cacheMarkers"] })}
            />
            <Select
              label="Cache lifetime"
              data={["5m", "1h"]}
              value={m.cacheMarkerTtl}
              allowDeselect={false}
              onChange={(v) => v && set({ cacheMarkerTtl: v as Model["cacheMarkerTtl"] })}
            />
          </Group>
        )}
        {protocol === "openai" && (
          <Group grow>
            <Select
              label="Cache markers"
              description="'anthropic' adds cache_control markers (Anthropic/Gemini models via OpenRouter)."
              data={["none", "anthropic"]}
              value={m.cacheMarkers}
              allowDeselect={false}
              onChange={(v) => v && set({ cacheMarkers: v as Model["cacheMarkers"] })}
            />
            <Select
              label="Cache lifetime"
              data={["5m", "1h"]}
              value={m.cacheMarkerTtl}
              allowDeselect={false}
              onChange={(v) => v && set({ cacheMarkerTtl: v as Model["cacheMarkerTtl"] })}
            />
            <Switch
              label="Send prompt cache key"
              checked={m.sendPromptCacheKey}
              onChange={(e) => set({ sendPromptCacheKey: e.currentTarget.checked })}
            />
          </Group>
        )}
        <Divider label="Prices (USD per million tokens, optional)" labelPosition="left" />
        <Group grow>
          {(["inputPerM", "cachedInputPerM", "cacheWritePerM", "outputPerM"] as const).map(
            (key) => (
              <NumberInput
                key={key}
                label={
                  {
                    inputPerM: "Input",
                    cachedInputPerM: "Cached input",
                    cacheWritePerM: "Cache write",
                    outputPerM: "Output",
                  }[key]
                }
                min={0}
                decimalScale={4}
                value={m.pricing?.[key] ?? ""}
                onChange={(v) => {
                  const value = typeof v === "number" ? v : 0;
                  const base = m.pricing ?? {
                    inputPerM: 0,
                    cachedInputPerM: 0,
                    cacheWritePerM: 0,
                    outputPerM: 0,
                  };
                  set({ pricing: { ...base, [key]: value } });
                }}
              />
            ),
          )}
        </Group>
        {m.pricing && (
          <Text
            size="xs"
            c="dimmed"
            td="underline"
            style={{ cursor: "pointer" }}
            onClick={() => set({ pricing: null })}
          >
            Clear prices
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave({ ...m, label: m.label.trim() || m.modelName });
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
