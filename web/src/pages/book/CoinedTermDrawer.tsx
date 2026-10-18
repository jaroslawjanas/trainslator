import {
  Alert,
  Button,
  Drawer,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { KB_KINDS, type KbKind } from "../../../../src/shared/schemas/kb.ts";

export interface CoinedTerm {
  kind: KbKind;
  source: string;
  target: string;
  note: string;
  /** Set when a later chunk translated the term differently. */
  conflict: string | null;
  /** The book's knowledge base entry with the same name, if any. */
  inKb: { id: string; target: string | null } | null;
}

export type CoinedFields = Pick<CoinedTerm, "kind" | "source" | "target" | "note">;

/** Edits a coined term: the fields later chunks use. */
export function CoinedTermDrawer({
  term,
  languages,
  onClose,
  onSave,
}: {
  term: CoinedTerm | null;
  languages: { source: string; target: string };
  onClose: () => void;
  onSave: (fields: CoinedFields) => Promise<void>;
}) {
  const [t, setT] = useState<CoinedTerm | null>(term);
  const [busy, setBusy] = useState(false);
  useEffect(() => setT(term), [term]);
  if (!t) return null;
  const set = (patch: Partial<CoinedTerm>) => setT((prev) => (prev ? { ...prev, ...patch } : prev));
  const save = async () => {
    setBusy(true);
    try {
      await onSave({ kind: t.kind, source: t.source, target: t.target, note: t.note });
      onClose();
    } catch {
      // the caller reported it; the drawer stays open
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      opened={term !== null}
      onClose={onClose}
      position="right"
      size="lg"
      title={term?.source ?? ""}
      styles={{ title: { fontFamily: "var(--tr-serif)" } }}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          Later chunks use your version. Passages already translated keep the old wording; change
          them with search and replace in Review.
        </Text>
        {t.conflict && (
          <Alert color="yellow" title="Translated two ways">
            Later, {t.conflict}. Saving keeps the translation below and settles this.
          </Alert>
        )}
        <Select
          label="Kind"
          data={[...KB_KINDS]}
          value={t.kind}
          allowDeselect={false}
          onChange={(v) => v && set({ kind: v as KbKind })}
        />
        <TextInput
          label={`${languages.source}: the original`}
          value={t.source}
          onChange={(x) => set({ source: x.currentTarget.value })}
        />
        <TextInput
          label={`${languages.target}: the translation`}
          value={t.target}
          onChange={(x) => set({ target: x.currentTarget.value })}
        />
        <Textarea
          label="Note"
          autosize
          minRows={2}
          value={t.note}
          onChange={(x) => set({ note: x.currentTarget.value })}
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!t.source.trim() || !t.target.trim()} onClick={save}>
            Save
          </Button>
        </Group>
      </Stack>
    </Drawer>
  );
}
