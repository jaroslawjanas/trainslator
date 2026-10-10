import {
  Alert,
  Box,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { post, put } from "../../api/client.ts";
import { UnitText } from "../../components/PlaceholderText.tsx";
import { useSettings } from "../SettingsPage.tsx";
import type { ReviewUnit } from "./types.ts";

interface Proposal {
  text: string;
  warnings: string[];
}

/**
 * One passage of one version: edit it yourself, or have a model rewrite it
 * (the whole passage, or the part you select), then save it to that version.
 */
export function RewriteModal({
  pid,
  bookId,
  unit,
  version,
  onClose,
  onSaved,
}: {
  pid: string;
  bookId: string;
  unit: ReviewUnit | null;
  version: { id: string; label: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const settings = useSettings();
  const s = settings.data?.settings;
  const original = (unit && version && unit.versions[version.id]?.text) ?? "";
  const [draft, setDraft] = useState(original);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [context, setContext] = useState(true);
  const [knowledgeBases, setKnowledgeBases] = useState(true);
  const [instruction, setInstruction] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);

  // A fresh start for every passage opened.
  useEffect(() => {
    setDraft(original);
    setSelection(null);
    setProposal(null);
    setInstruction("");
  }, [original]);
  useEffect(() => {
    if (!modelId && s) setModelId(s.steps["phase3.translate"].modelId ?? s.models[0]?.id ?? null);
  }, [modelId, s]);

  if (!unit || !version) return null;
  const selected = selection && selection.end > selection.start ? selection : null;
  const models = (s?.models ?? []).map((m) => ({
    value: m.id,
    label: `${m.label || m.modelName} (${s?.connections.find((c) => c.id === m.connectionId)?.name ?? "?"})`,
  }));

  const rewrite = async () => {
    if (!modelId) return;
    setAsking(true);
    setProposal(null);
    try {
      setProposal(
        await post<Proposal>(`/api/projects/${pid}/books/${bookId}/units/${unit.urlKey}/rewrite`, {
          version: version.id,
          text: draft,
          selection: selected,
          modelId,
          context,
          knowledgeBases,
          instruction: instruction.trim() || null,
        }),
      );
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't rewrite it",
        message: (e as Error).message,
      });
    } finally {
      setAsking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await put(
        `/api/projects/${pid}/books/${bookId}/versions/${version.id}/units/${unit.urlKey}`,
        {
          text: draft,
        },
      );
      notifications.show({ color: "green", message: `Saved to ${version.label}.` });
      onSaved();
      onClose();
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={`Edit or rewrite: ${version.label}`} size="xl">
      <Stack gap="md">
        <Box>
          <Text size="xs" c="dimmed" mb={4}>
            Original
          </Text>
          <UnitText text={unit.source} placeholders={unit.placeholders} />
        </Box>
        <Textarea
          label={version.label}
          description="Edit it yourself, or select a part of it to rewrite only that part. Keep the formatting tags such as <g1>…</g1>."
          autosize
          minRows={3}
          value={draft}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setSelection(null);
          }}
          onSelect={(e) =>
            setSelection({
              start: e.currentTarget.selectionStart,
              end: e.currentTarget.selectionEnd,
            })
          }
          styles={{ input: { fontFamily: "var(--tr-serif)", fontSize: 16, lineHeight: 1.55 } }}
        />
        <Group align="flex-end" gap="md" wrap="wrap">
          <Select
            label="Model"
            data={models}
            value={modelId}
            onChange={setModelId}
            allowDeselect={false}
            style={{ flex: "1 1 260px" }}
          />
          <TextInput
            label="Instruction"
            placeholder="Optional, e.g. more natural, shorter, keep the pun"
            value={instruction}
            onChange={(e) => setInstruction(e.currentTarget.value)}
            style={{ flex: "2 1 320px" }}
          />
        </Group>
        <Group gap="xl">
          <Switch
            label="Send the passages around it"
            checked={context}
            onChange={(e) => setContext(e.currentTarget.checked)}
          />
          <Switch
            label="Send the knowledge bases"
            checked={knowledgeBases}
            onChange={(e) => setKnowledgeBases(e.currentTarget.checked)}
          />
        </Group>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {selected
              ? `Rewrites the selected part (${selected.end - selected.start} characters); the rest stays.`
              : "Rewrites the whole passage."}
          </Text>
          <Button variant="default" loading={asking} disabled={!modelId} onClick={rewrite}>
            {selected ? "Rewrite the selection" : "Rewrite the passage"}
          </Button>
        </Group>
        {proposal && (
          <Alert color="bookcloth" variant="light" title="Proposal">
            <UnitText text={proposal.text} placeholders={unit.placeholders} />
            {proposal.warnings.map((w) => (
              <Text key={w} size="sm" c="yellow" mt={4}>
                {w}
              </Text>
            ))}
            <Group gap="xs" mt="sm">
              <Button
                size="xs"
                onClick={() => {
                  setDraft(proposal.text);
                  setSelection(null);
                  setProposal(null);
                }}
              >
                Use it
              </Button>
              <Button size="xs" variant="default" onClick={() => setProposal(null)}>
                Discard
              </Button>
            </Group>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} disabled={draft === original || !draft.trim()} onClick={save}>
            Save to {version.label}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
