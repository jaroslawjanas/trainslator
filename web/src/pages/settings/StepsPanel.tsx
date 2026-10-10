import {
  Autocomplete,
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import type { Settings, StepSettings } from "../../../../src/shared/schemas/settings.ts";
import { STEPS, type Step, type StepInfo } from "../../../../src/shared/steps.ts";
import { put } from "../../api/client.ts";
import { JsonField } from "../../components/JsonField.tsx";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const TIER_COLOR = { fast: "teal", medium: "blue", strong: "grape" } as const;

export function StepsPanel({
  settings,
  steps: info,
  onSaved,
}: {
  settings: Settings;
  steps: Record<Step, StepInfo>;
  onSaved: (s: Settings) => void;
}) {
  const [steps, setSteps] = useState(settings.steps);
  const [invalid, setInvalid] = useState<Set<Step>>(new Set());
  const [saving, setSaving] = useState(false);
  useEffect(() => setSteps(settings.steps), [settings.steps]);

  const modelOptions = settings.models.map((m) => ({
    value: m.id,
    label: `${m.label} · ${settings.connections.find((c) => c.id === m.connectionId)?.name ?? "?"}`,
  }));
  const set = (step: Step, patch: Partial<StepSettings>) =>
    setSteps((prev) => ({ ...prev, [step]: { ...prev[step], ...patch } }));
  const dirty = JSON.stringify(steps) !== JSON.stringify(settings.steps);

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Choose which model each step uses. A fast model is usually enough for reading reference
        chapters; translation benefits most from a strong one.
      </Text>
      {settings.models.length === 0 && (
        <Text size="sm" c="orange">
          Add a connection and a model first.
        </Text>
      )}
      {STEPS.map((step) => {
        const s = steps[step];
        const meta = info[step];
        return (
          <Paper key={step} withBorder p="md">
            <Stack gap="sm">
              <Group justify="space-between">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>{meta.label}</Text>
                    <Badge size="xs" variant="light" color={TIER_COLOR[meta.suggestedTier]}>
                      suggested: {meta.suggestedTier}
                    </Badge>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {meta.description}
                  </Text>
                </div>
              </Group>
              <Group grow align="flex-start">
                <Select
                  label="Model"
                  data={modelOptions}
                  value={s.modelId}
                  placeholder="Not set"
                  clearable
                  onChange={(v) => set(step, { modelId: v })}
                />
                <NumberInput
                  label="Temperature"
                  description="Empty = provider default"
                  min={0}
                  max={2}
                  step={0.1}
                  decimalScale={2}
                  value={s.temperature ?? ""}
                  onChange={(v) => set(step, { temperature: typeof v === "number" ? v : null })}
                />
                <NumberInput
                  label="Max output tokens"
                  description="Empty = the model's maximum"
                  min={256}
                  step={1000}
                  value={s.maxOutputTokens ?? ""}
                  onChange={(v) => set(step, { maxOutputTokens: typeof v === "number" ? v : null })}
                />
              </Group>
              <Group grow align="flex-end">
                <Switch
                  label="Reasoning"
                  checked={s.reasoning.enabled}
                  onChange={(e) =>
                    set(step, { reasoning: { ...s.reasoning, enabled: e.currentTarget.checked } })
                  }
                />
                <Autocomplete
                  label="Effort"
                  data={EFFORTS}
                  disabled={!s.reasoning.enabled}
                  value={s.reasoning.effort ?? ""}
                  onChange={(v) => set(step, { reasoning: { ...s.reasoning, effort: v || null } })}
                />
                <NumberInput
                  label="Budget (tokens)"
                  description="For providers that take a budget"
                  disabled={!s.reasoning.enabled}
                  min={256}
                  step={1024}
                  value={s.reasoning.budgetTokens ?? ""}
                  onChange={(v) =>
                    set(step, {
                      reasoning: { ...s.reasoning, budgetTokens: typeof v === "number" ? v : null },
                    })
                  }
                />
              </Group>
              <JsonField
                label="Extra request parameters (JSON, merged last)"
                value={s.extraBody}
                onChange={(v, ok) => {
                  setInvalid((prev) => {
                    const next = new Set(prev);
                    if (ok) next.delete(step);
                    else next.add(step);
                    return next;
                  });
                  if (ok) set(step, { extraBody: v });
                }}
              />
            </Stack>
          </Paper>
        );
      })}
      <Group justify="flex-end">
        <Button variant="default" disabled={!dirty} onClick={() => setSteps(settings.steps)}>
          Undo changes
        </Button>
        <Button
          disabled={!dirty || invalid.size > 0}
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              const res = await put<{ settings: Settings }>("/api/settings/steps", steps);
              onSaved(res.settings);
              notifications.show({ color: "green", message: "Step settings saved." });
            } catch (e) {
              notifications.show({
                color: "red",
                title: "Couldn't save",
                message: (e as Error).message,
              });
            } finally {
              setSaving(false);
            }
          }}
        >
          Save step settings
        </Button>
      </Group>
    </Stack>
  );
}
