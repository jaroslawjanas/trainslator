import { Anchor, Badge, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { get, post } from "../../api/client.ts";
import { useJobs } from "../../components/JobsIndicator.tsx";
import { Section } from "../../components/PageHeader.tsx";
import { formatDate, listText, plural } from "../../lib/format.ts";
import { ACTIVE_JOB } from "../../lib/stages.ts";
import type { HistoryView, SavedKnowledgeView, SavedTranslationView } from "./types.ts";

const REASONS: Record<SavedTranslationView["reason"], string> = {
  run: "after a translation run",
  redo: "before the whole book was translated again",
  restore: "before another translation was restored",
  build: "when the EPUB was built",
  manual: "by you",
  replace: "before text in it was replaced",
};

/** "Whole chapters, gpt-5, reasoning at effort high." */
export function settingsText(t: SavedTranslationView): string {
  const parts: string[] = [];
  if (t.modes.length === 1) parts.push(t.modes[0] === "chapters" ? "Whole chapters" : "Chunks");
  else if (t.modes.length > 1) parts.push("Chunks and whole chapters");
  if (t.models.length > 0) parts.push(listText(t.models));
  const efforts = t.reasoning.filter((r) => r !== "on" && r !== "off");
  if (t.reasoning.length === 1 && t.reasoning[0] === "off") parts.push("no reasoning");
  else if (efforts.length > 0) parts.push(`reasoning at effort ${listText(efforts)}`);
  else if (t.reasoning.includes("on")) parts.push("reasoning on");
  if (parts.length === 0) return "";
  const text = parts.join(", ");
  const capitalize = t.modes.length > 0 || t.models.length === 0;
  return capitalize ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : `${text}.`;
}

function countsText(t: SavedTranslationView): string {
  const c = t.counts;
  const attention = c.flagged + c.refused;
  const parts = [
    `${plural(c.units, "passage")} translated`,
    c.pending > 0 ? `${c.pending.toLocaleString()} not translated` : null,
    attention > 0 ? `${attention.toLocaleString()} need attention` : null,
    c.edited > 0 ? `${c.edited.toLocaleString()} edited by you` : null,
  ].filter(Boolean);
  const cost =
    t.usage.cost !== null && t.usage.cost > 0
      ? ` About $${t.usage.cost < 0.01 ? t.usage.cost.toFixed(4) : t.usage.cost.toFixed(2)}.`
      : "";
  return `${parts.join(", ")}.${cost}`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function Entry({
  pid,
  bookId,
  t,
  current,
  busy,
}: {
  pid: string;
  bookId: string;
  t: SavedTranslationView;
  current: boolean;
  busy: boolean;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [restoring, setRestoring] = useState(false);
  const base = `/api/projects/${pid}/books/${bookId}`;
  const restore = async () => {
    if (
      !window.confirm(
        `Make Translation ${t.number} the current translation? The current one is saved here first, so you can come back to it.`,
      )
    )
      return;
    setRestoring(true);
    try {
      await post(`${base}/history/translations/${t.id}/restore`);
      await client.invalidateQueries({ queryKey: ["book", bookId] });
      await client.invalidateQueries({ queryKey: ["target", bookId] });
      notifications.show({ color: "green", message: `Translation ${t.number} restored.` });
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't restore",
        message: (e as Error).message,
      });
    } finally {
      setRestoring(false);
    }
  };
  const settings = settingsText(t);
  return (
    <Box className="tr-history-entry" data-current={current || undefined}>
      <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
        <Stack gap={2} style={{ flex: "1 1 420px", minWidth: 0 }}>
          <Group gap="xs">
            <Text fw={600} size="md">
              Translation {t.number}
            </Text>
            {current && (
              <Badge size="sm" variant="light" color="bookcloth">
                Current
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            Saved {formatDate(t.savedAt)}, {REASONS[t.reason]}.
          </Text>
          {settings && <Text size="sm">{settings}</Text>}
          <Text size="sm">{countsText(t)}</Text>
        </Stack>
        {!current && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              onClick={() =>
                navigate(`/projects/${pid}/books/${bookId}/review?cols=source,current,${t.id}`)
              }
            >
              Compare in Review
            </Button>
            <Button
              size="xs"
              variant="default"
              loading={restoring}
              disabled={busy}
              onClick={restore}
            >
              Restore
            </Button>
          </Group>
        )}
      </Group>
      {t.builds.length > 0 && (
        <Stack gap={4} mt="sm">
          {[...t.builds].reverse().map((b) => (
            <Group key={b.id} gap="xs" wrap="nowrap">
              <IconDownload size={14} stroke={1.8} color="var(--tr-faint)" />
              <Anchor
                size="sm"
                href={`${base}/history/builds/${b.id}`}
                download={b.fileName}
                className="mono"
              >
                {b.fileName}
              </Anchor>
              <Text size="sm" c="dimmed">
                built {formatDate(b.builtAt)}, {megabytes(b.bytes)}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Box>
  );
}

const KNOWLEDGE_REASONS: Record<SavedKnowledgeView["reason"], string> = {
  rebuild: "before the whole book was read again",
  restore: "before another knowledge base was restored",
};

function KnowledgeEntry({
  pid,
  bookId,
  k,
  current,
  busy,
}: {
  pid: string;
  bookId: string;
  k: SavedKnowledgeView;
  current: boolean;
  busy: boolean;
}) {
  const client = useQueryClient();
  const [restoring, setRestoring] = useState(false);
  const restore = async () => {
    if (
      !window.confirm(
        `Make knowledge base ${k.number} the book's knowledge base again, with its chapter notes and your changes from then? The current one is saved here first.`,
      )
    )
      return;
    setRestoring(true);
    try {
      await post(`/api/projects/${pid}/books/${bookId}/history/knowledge/${k.id}/restore`);
      await client.invalidateQueries({ queryKey: ["book", bookId] });
      await client.invalidateQueries({ queryKey: ["target", bookId] });
      notifications.show({ color: "green", message: `Knowledge base ${k.number} restored.` });
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't restore",
        message: (e as Error).message,
      });
    } finally {
      setRestoring(false);
    }
  };
  return (
    <Box className="tr-history-entry">
      <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
        <Stack gap={2} style={{ flex: "1 1 420px", minWidth: 0 }}>
          <Group gap="xs">
            <Text fw={600} size="md">
              Knowledge base {k.number}
            </Text>
            {current && (
              <Badge size="sm" variant="light" color="bookcloth">
                Current
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            Saved {formatDate(k.savedAt)}, {KNOWLEDGE_REASONS[k.reason]}.
          </Text>
          <Text size="sm">
            {plural(k.entries, "entry", "entries")}, {plural(k.open, "open question")},{" "}
            {k.locked.toLocaleString()} set by you.
          </Text>
        </Stack>
        {!current && (
          <Button size="xs" variant="default" loading={restoring} disabled={busy} onClick={restore}>
            Restore
          </Button>
        )}
      </Group>
    </Box>
  );
}

export function HistoryPanel({ pid, bookId }: { pid: string; bookId: string }) {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const history = useQuery({
    queryKey: ["target", bookId, "history"],
    queryFn: () => get<HistoryView>(`/api/projects/${pid}/books/${bookId}/history`),
  });
  const jobs = useJobs();
  const busy = (jobs.data?.jobs ?? []).some(
    (j) => j.targetId === bookId && ACTIVE_JOB.includes(j.status),
  );
  if (history.isLoading || !history.data) return <Loader size="sm" />;
  const { translations, current, knowledgeBases, currentKnowledge } = history.data;
  const savedAs = translations.find((t) => t.id === current?.savedAs);
  const saveNow = async () => {
    setSaving(true);
    try {
      await post(`/api/projects/${pid}/books/${bookId}/history/translations`);
      await client.invalidateQueries({ queryKey: ["target", bookId, "history"] });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Box maw={900}>
      <Group gap="md" mb="xl" align="center">
        <Text size="md" style={{ flex: "1 1 420px" }}>
          {!current
            ? "Nothing is translated now."
            : savedAs
              ? `The current translation is Translation ${savedAs.number}.`
              : "The current translation isn't saved yet. It's saved when you build the EPUB, translate the whole book again, or restore another translation."}
          {busy && " A job is running for this book, so restoring waits until it ends."}
        </Text>
        {current && !savedAs && (
          <Button size="xs" loading={saving} onClick={saveNow}>
            Save it now
          </Button>
        )}
      </Group>
      <Section title="Translations">
        {translations.length === 0 ? (
          <Text size="md" c="dimmed">
            Nothing saved yet. Each translation run and each build is saved here.
          </Text>
        ) : (
          <Stack gap={0}>
            {[...translations].reverse().map((t) => (
              <Entry
                key={t.id}
                pid={pid}
                bookId={bookId}
                t={t}
                current={t.id === current?.savedAs}
                busy={busy}
              />
            ))}
          </Stack>
        )}
      </Section>
      <Section
        title="Knowledge bases"
        description="The book's knowledge base is saved, with phase 2's chapter notes and your changes, before the whole book is read again."
      >
        {knowledgeBases.length === 0 ? (
          <Text size="md" c="dimmed">
            Nothing saved yet.
          </Text>
        ) : (
          <Stack gap={0}>
            {[...knowledgeBases].reverse().map((k) => (
              <KnowledgeEntry
                key={k.id}
                pid={pid}
                bookId={bookId}
                k={k}
                current={k.id === currentKnowledge}
                busy={busy}
              />
            ))}
          </Stack>
        )}
      </Section>
    </Box>
  );
}
