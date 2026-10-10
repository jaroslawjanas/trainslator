import {
  Autocomplete,
  Box,
  Button,
  Collapse,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconChevronRight } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type {
  AdvisorSettings,
  Settings,
  StepSettings,
} from "../../../../src/shared/schemas/settings.ts";
import { STEPS, type Step, type StepInfo } from "../../../../src/shared/steps.ts";
import { put } from "../../api/client.ts";
import { JsonField } from "../../components/JsonField.tsx";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const TIER_TEXT = {
  fast: "A fast, inexpensive model is enough.",
  medium: "A mid-range model works well.",
  strong: "Use the strongest model you can afford.",
} as const;

/** The advisor: a strong model the steps' models may ask, through a tool call. */
function AdvisorSection({
  advisor,
  modelOptions,
  onChange,
}: {
  advisor: AdvisorSettings;
  modelOptions: { value: string; label: string }[];
  onChange: (patch: Partial<AdvisorSettings>) => void;
}) {
  return (
    <Box py="lg" style={{ borderTop: "1px solid var(--tr-rule)" }}>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl" verticalSpacing="sm">
        <Box>
          <Text className="serif" fw={600} size="lg">
            Advisor
          </Text>
          <Text size="sm" c="dimmed">
            The strongest model you have, for the other models to ask when they're unsure: a hard
            passage, wordplay, a name with no translation yet. It sees only the question it's asked,
            so it costs little per question. Choose below which steps may ask it; their models must
            be able to call tools (Test checks this).
          </Text>
        </Box>
        <Stack gap="xs">
          <Switch
            label="Use an advisor"
            checked={advisor.enabled}
            onChange={(e) => onChange({ enabled: e.currentTarget.checked })}
          />
          <Select
            aria-label="Advisor model"
            data={modelOptions}
            value={advisor.modelId}
            placeholder="Choose the advisor's model"
            clearable
            error={advisor.enabled && !advisor.modelId ? "Choose a model for the advisor." : null}
            onChange={(v) => onChange({ modelId: v })}
          />
          <Group gap="md" wrap="nowrap" align="center">
            <Switch
              label="Reasoning"
              checked={advisor.reasoning.enabled}
              onChange={(e) =>
                onChange({ reasoning: { ...advisor.reasoning, enabled: e.currentTarget.checked } })
              }
            />
            {advisor.reasoning.enabled && (
              <Autocomplete
                aria-label="Advisor reasoning effort"
                placeholder="Effort, e.g. high"
                data={EFFORTS}
                filter={({ options }) => options}
                value={advisor.reasoning.effort ?? ""}
                onChange={(v) =>
                  onChange({ reasoning: { ...advisor.reasoning, effort: v || null } })
                }
                style={{ flex: 1 }}
              />
            )}
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <NumberInput
              label="Questions per request"
              description="The most one request may ask"
              min={1}
              max={10}
              value={advisor.maxConsultations}
              onChange={(v) => typeof v === "number" && onChange({ maxConsultations: v })}
            />
            <NumberInput
              label="Output limit"
              description="Per answer. Empty: the model's"
              min={256}
              step={1000}
              value={advisor.maxOutputTokens ?? ""}
              onChange={(v) => onChange({ maxOutputTokens: typeof v === "number" ? v : null })}
            />
          </SimpleGrid>
        </Stack>
      </SimpleGrid>
    </Box>
  );
}

function hasAdvanced(s: StepSettings): boolean {
  return (
    s.temperature !== null ||
    s.maxOutputTokens !== null ||
    s.reasoning.budgetTokens !== null ||
    s.extraBody !== null
  );
}

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
  const [advisor, setAdvisor] = useState(settings.advisor);
  const [invalid, setInvalid] = useState<Set<Step>>(new Set());
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<Set<Step>>(
    () => new Set(STEPS.filter((s) => hasAdvanced(settings.steps[s]))),
  );
  useEffect(() => setSteps(settings.steps), [settings.steps]);
  useEffect(() => setAdvisor(settings.advisor), [settings.advisor]);

  const modelOptions = settings.models.map((m) => ({
    value: m.id,
    label: `${m.label} (${settings.connections.find((c) => c.id === m.connectionId)?.name ?? "?"})`,
  }));
  const set = (step: Step, patch: Partial<StepSettings>) =>
    setSteps((prev) => ({ ...prev, [step]: { ...prev[step], ...patch } }));
  const stepsDirty = JSON.stringify(steps) !== JSON.stringify(settings.steps);
  const advisorDirty = JSON.stringify(advisor) !== JSON.stringify(settings.advisor);
  const dirty = stepsDirty || advisorDirty;
  const advisorInvalid = advisor.enabled && !advisor.modelId;
  const toggle = (step: Step) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });

  return (
    <Stack gap={0}>
      <Text size="sm" c="dimmed" mb="lg" maw={720}>
        Which model does each step. A fast model is usually enough for reading the reference
        chapters; the translation itself benefits most from a strong one.
      </Text>
      {settings.models.length === 0 && (
        <Text size="sm" c="yellow" mb="lg">
          Add a connection and a model first.
        </Text>
      )}
      <AdvisorSection
        advisor={advisor}
        modelOptions={modelOptions}
        onChange={(patch) => setAdvisor((prev) => ({ ...prev, ...patch }))}
      />
      {STEPS.map((step) => {
        const s = steps[step];
        const meta = info[step];
        const expanded = open.has(step);
        const model = settings.models.find((m) => m.id === s.modelId);
        // Claude Code can't be given the advisor tool.
        const viaClaudeCode =
          settings.connections.find((c) => c.id === model?.connectionId)?.kind === "claude_code";
        return (
          <Box key={step} py="lg" style={{ borderTop: "1px solid var(--tr-rule)" }}>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl" verticalSpacing="sm">
              <Box>
                <Text className="serif" fw={600} size="lg">
                  {meta.label}
                </Text>
                <Text size="sm" c="dimmed">
                  {meta.description} {TIER_TEXT[meta.suggestedTier]}
                </Text>
              </Box>
              <Stack gap="xs">
                <Select
                  aria-label={`Model for ${meta.label}`}
                  data={modelOptions}
                  value={s.modelId}
                  placeholder="Choose a model"
                  clearable
                  onChange={(v) => set(step, { modelId: v })}
                />
                <Group gap="md" wrap="nowrap" align="center">
                  <Switch
                    label="Reasoning"
                    checked={s.reasoning.enabled}
                    onChange={(e) =>
                      set(step, {
                        reasoning: { ...s.reasoning, enabled: e.currentTarget.checked },
                      })
                    }
                  />
                  {s.reasoning.enabled && (
                    <Autocomplete
                      aria-label="Reasoning effort"
                      placeholder="Effort, e.g. medium"
                      data={EFFORTS}
                      // List every effort, not only those matching the current value.
                      filter={({ options }) => options}
                      value={s.reasoning.effort ?? ""}
                      onChange={(v) =>
                        set(step, { reasoning: { ...s.reasoning, effort: v || null } })
                      }
                      style={{ flex: 1 }}
                    />
                  )}
                </Group>
                <Switch
                  label="May ask the advisor"
                  description={
                    viaClaudeCode
                      ? "Claude Code models can't ask the advisor."
                      : advisor.enabled
                        ? undefined
                        : "Turn on the advisor above first."
                  }
                  disabled={!advisor.enabled || viaClaudeCode}
                  checked={s.consultAdvisor && !viaClaudeCode}
                  onChange={(e) => set(step, { consultAdvisor: e.currentTarget.checked })}
                />
                <UnstyledButton
                  onClick={() => toggle(step)}
                  aria-expanded={expanded}
                  style={{ alignSelf: "flex-start" }}
                >
                  <Group gap={4}>
                    <IconChevronRight
                      size={14}
                      style={{
                        transform: expanded ? "rotate(90deg)" : undefined,
                        transition: "transform 120ms",
                      }}
                    />
                    <Text size="sm" c="dimmed">
                      More options
                    </Text>
                  </Group>
                </UnstyledButton>
                <Collapse expanded={expanded}>
                  <Stack gap="sm" pt={4}>
                    <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
                      <NumberInput
                        label="Temperature"
                        description="Empty: provider default"
                        min={0}
                        max={2}
                        step={0.1}
                        decimalScale={2}
                        value={s.temperature ?? ""}
                        onChange={(v) =>
                          set(step, { temperature: typeof v === "number" ? v : null })
                        }
                      />
                      <NumberInput
                        label="Output limit"
                        description="Empty: the model's"
                        min={256}
                        step={1000}
                        value={s.maxOutputTokens ?? ""}
                        onChange={(v) =>
                          set(step, { maxOutputTokens: typeof v === "number" ? v : null })
                        }
                      />
                      <NumberInput
                        label="Reasoning budget"
                        description="For providers that take one"
                        disabled={!s.reasoning.enabled}
                        min={256}
                        step={1024}
                        value={s.reasoning.budgetTokens ?? ""}
                        onChange={(v) =>
                          set(step, {
                            reasoning: {
                              ...s.reasoning,
                              budgetTokens: typeof v === "number" ? v : null,
                            },
                          })
                        }
                      />
                    </SimpleGrid>
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
                </Collapse>
              </Stack>
            </SimpleGrid>
          </Box>
        );
      })}
      <Group
        justify="flex-end"
        py="md"
        style={{
          borderTop: "1px solid var(--tr-rule)",
          position: "sticky",
          bottom: 0,
          background: "var(--tr-paper)",
        }}
      >
        <Button
          variant="default"
          disabled={!dirty}
          onClick={() => {
            setSteps(settings.steps);
            setAdvisor(settings.advisor);
          }}
        >
          Undo changes
        </Button>
        <Button
          disabled={!dirty || invalid.size > 0 || advisorInvalid}
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              let saved = settings;
              // The advisor first: a step may only ask an advisor that exists.
              if (advisorDirty)
                saved = (await put<{ settings: Settings }>("/api/settings/advisor", advisor))
                  .settings;
              if (stepsDirty)
                saved = (await put<{ settings: Settings }>("/api/settings/steps", steps)).settings;
              onSaved(saved);
              notifications.show({ color: "green", message: "Models for each step saved." });
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
          Save
        </Button>
      </Group>
    </Stack>
  );
}
