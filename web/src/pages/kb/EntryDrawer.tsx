import {
  ActionIcon,
  Alert,
  Button,
  Drawer,
  Fieldset,
  Group,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { KB_KINDS, KB_TREATMENTS, type KbEntry } from "../../../../src/shared/schemas/kb.ts";
import { useSettings } from "../SettingsPage.tsx";

/** A model's proposal for an open question. */
export interface KbAnswer {
  target: string | null;
  treatment: KbEntry["treatment"];
  attributes: { key: string; value: string }[];
  note: string;
  explanation: string;
}

/** Ask a model about an open question: the advisor's model by default. */
function AskModel({
  e,
  onAsk,
  onUse,
}: {
  e: KbEntry;
  onAsk: (e: KbEntry, modelId: string) => Promise<KbAnswer>;
  onUse: (answer: KbAnswer) => void;
}) {
  const settings = useSettings();
  const s = settings.data?.settings;
  const advisorId = s?.advisor.modelId ?? null;
  const [modelId, setModelId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<KbAnswer | null>(null);
  useEffect(() => {
    if (!modelId && s)
      setModelId(
        advisorId ??
          s.steps["phase2.review"].modelId ??
          s.steps["phase2.chapter"].modelId ??
          s.models[0]?.id ??
          null,
      );
  }, [modelId, s, advisorId]);
  // A new entry starts without an answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the entry changes
  useEffect(() => setAnswer(null), [e.id]);
  const models = (s?.models ?? []).map((m) => ({
    value: m.id,
    label: `${m.label || m.modelName}${m.id === advisorId ? " (advisor)" : ""}`,
  }));
  const label = models.find((m) => m.value === modelId)?.label ?? "The model";
  const ask = async () => {
    if (!modelId) return;
    setAsking(true);
    setAnswer(null);
    try {
      setAnswer(await onAsk(e, modelId));
    } catch (err) {
      notifications.show({
        color: "red",
        title: "Couldn't get an answer",
        message: (err as Error).message,
      });
    } finally {
      setAsking(false);
    }
  };
  return (
    <>
      <Group mt="sm" gap="xs" wrap="nowrap">
        <Select
          size="xs"
          aria-label="Model to ask"
          data={models}
          value={modelId}
          onChange={setModelId}
          allowDeselect={false}
          style={{ flex: 1 }}
        />
        <Button size="xs" variant="default" loading={asking} disabled={!modelId} onClick={ask}>
          Ask
        </Button>
      </Group>
      {answer && (
        <Stack gap={4} mt="md">
          <Text size="sm" fw={600}>
            {label.replace(/ \(advisor\)$/, "")} suggests
          </Text>
          <Text size="sm">{answer.explanation}</Text>
          <Text size="sm">
            Translation: {answer.target ?? "undecided"}
            {answer.treatment ? ` (${answer.treatment})` : ""}
          </Text>
          {answer.attributes.length > 0 && (
            <Text size="sm">
              Facts: {answer.attributes.map((a) => `${a.key}: ${a.value}`).join("; ")}
            </Text>
          )}
          {answer.note && <Text size="sm">Note: {answer.note}</Text>}
          <Group gap="xs" mt={6}>
            <Button
              size="xs"
              onClick={() => {
                onUse(answer);
                setAnswer(null);
              }}
            >
              Use this answer
            </Button>
            <Button size="xs" variant="default" onClick={() => setAnswer(null)}>
              Discard
            </Button>
          </Group>
        </Stack>
      )}
    </>
  );
}

export function EntryDrawer({
  entry,
  isNew,
  onClose,
  onSave,
  onSaveUnlocked,
  onUnlock,
  onDelete,
  onAsk,
  languages,
}: {
  entry: KbEntry | null;
  isNew: boolean;
  /** The book's languages, e.g. English and Polish, to say which fields are in which. */
  languages: { source: string; target: string };
  onClose: () => void;
  onSave: (e: KbEntry) => Promise<void>;
  /** Save without locking: later runs may still change the entry. */
  onSaveUnlocked: (e: KbEntry) => Promise<void>;
  onUnlock: (e: KbEntry) => Promise<void>;
  onDelete: (e: KbEntry) => Promise<void>;
  onAsk: (e: KbEntry, modelId: string) => Promise<KbAnswer>;
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
      styles={{ title: { fontFamily: "var(--tr-serif)" } }}
    >
      <Stack>
        {!isNew && (
          <Text size="sm" c="dimmed">
            {e.status === "locked"
              ? "Locked: set by you and kept when phases run again."
              : e.status === "open"
                ? "Open: the AI couldn't decide this yet."
                : "Added automatically."}{" "}
            {e.origin === "user"
              ? "You added it."
              : `Found in ${e.origin === "phase1" ? "the reference pair" : "this book"}${e.refs.length > 0 ? `, in ${e.refs.length} chapter${e.refs.length === 1 ? "" : "s"}` : ""}.`}
          </Text>
        )}
        {e.status === "open" && e.question && (
          <Alert color="yellow" title="Open question">
            {e.question}
            {!isNew && (
              <AskModel
                e={e}
                onAsk={onAsk}
                onUse={(a) =>
                  set({
                    target: a.target,
                    treatment: a.treatment,
                    attributes: a.attributes,
                    note: a.note,
                  })
                }
              />
            )}
          </Alert>
        )}
        {e.status !== "locked" && (
          <Text size="xs" c="dimmed">
            {isNew
              ? "Saving locks the entry: later runs keep it exactly as you set it."
              : "Locked, the entry stays exactly as you set it when phases run again. Without locking, they may still change it."}
          </Text>
        )}
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
        <Fieldset legend={`${languages.source}: the original`}>
          <Stack gap="sm">
            <TextInput
              label="Name or term"
              description={`As it appears in the ${languages.source} text.`}
              value={e.source}
              onChange={(x) => set({ source: x.currentTarget.value })}
            />
            <TagsInput
              label="Also written as"
              description={`Other spellings or short forms in ${languages.source}, e.g. a nickname.`}
              value={e.aliases}
              onChange={(v) => set({ aliases: v })}
            />
          </Stack>
        </Fieldset>
        <Fieldset legend={`${languages.target}: the translation`}>
          <Stack gap="sm">
            <TextInput
              label="Translation"
              description="Its dictionary form: the form a dictionary would list."
              value={e.target ?? ""}
              onChange={(x) => set({ target: x.currentTarget.value || null })}
            />
            <TagsInput
              label={`Other forms in ${languages.target}`}
              description="Inflected forms and variants that appear in the translated text."
              value={e.targetSeen}
              onChange={(v) => set({ targetSeen: v })}
            />
          </Stack>
        </Fieldset>
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
                <IconX size={14} />
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
              <Text key={i} size="sm" c="dimmed" className="serif">
                “{x.source}”{x.target ? ` becomes “${x.target}”` : ""}
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
                px="xs"
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
            {!isNew && e.status !== "locked" && (
              <Button
                variant="default"
                loading={busy}
                disabled={!e.source.trim()}
                onClick={() => act(() => onSaveUnlocked(e))}
              >
                Save without locking
              </Button>
            )}
            <Button loading={busy} disabled={!e.source.trim()} onClick={() => act(() => onSave(e))}>
              {e.status === "open" ? "Answer and lock" : "Save and lock"}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Drawer>
  );
}
