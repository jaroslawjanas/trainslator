import { Alert, Badge, Box, Button, Checkbox, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { KbOverrides } from "../../../../src/shared/schemas/kb.ts";
import { get, post } from "../../api/client.ts";
import { formatDate, listText, plural } from "../../lib/format.ts";

type Scope = "pair" | "book";

/** What you changed by hand in a knowledge base, counted for the dialog. */
function ownChanges(overrides: KbOverrides | undefined): string[] {
  if (!overrides) return [];
  const entries = Object.values(overrides.entries);
  const set = entries.filter((e) => e.entry !== null).length;
  const deleted = entries.length - set;
  const rules = Object.values(overrides.styleRules).length;
  return [
    set > 0 ? `${plural(set, "entry", "entries")} you set or answered` : null,
    deleted > 0 ? plural(deleted, "deleted entry", "deleted entries") : null,
    rules > 0 ? `${plural(rules, "style rule")} you wrote or changed` : null,
  ].filter((x): x is string => x !== null);
}

/** Every query that shows the knowledge base or the phase that builds it. */
export async function refreshKnowledge(
  client: ReturnType<typeof useQueryClient>,
  pid: string,
  targetId: string,
) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["target", targetId] }),
    client.invalidateQueries({ queryKey: ["pair", targetId] }),
    client.invalidateQueries({ queryKey: ["book", targetId] }),
    client.invalidateQueries({ queryKey: ["project", pid] }),
    client.invalidateQueries({ queryKey: ["jobs"] }),
  ]);
}

/**
 * Start over with an empty knowledge base: a copy is saved first, your own
 * changes stay unless you drop them, and the next run of the phase asks the
 * models anew. Used on the Knowledge base page of pairs and books, and for
 * "Read the whole book again" on a book's Reading page.
 */
export function StartOverModal({
  pid,
  scope,
  targetId,
  opened,
  costText = null,
  onClose,
}: {
  pid: string;
  scope: Scope;
  targetId: string;
  opened: boolean;
  /** The estimate for running the phase again, when known. */
  costText?: string | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [dropOwn, setDropOwn] = useState(false);
  const [busy, setBusy] = useState<"clear" | "run" | null>(null);
  const base = `/api/projects/${pid}/${scope === "pair" ? "pairs" : "books"}/${targetId}`;
  const kb = useQuery({
    queryKey: ["target", targetId, "kb"],
    queryFn: () => get<{ overrides: KbOverrides }>(`${base}/kb`),
    enabled: opened,
  });
  const pair = useQuery({
    queryKey: ["pair", targetId],
    queryFn: () => get<{ alignment: { status: string } }>(base),
    enabled: opened && scope === "pair",
  });
  // Edits made on the page since it loaded change what "your own changes" counts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch only when the dialog opens
  useEffect(() => {
    if (opened) void kb.refetch();
  }, [opened]);
  const own = ownChanges(kb.data?.overrides);
  const confirmed = scope === "book" || pair.data?.alignment.status === "confirmed";
  const phase = scope === "pair" ? "Learning" : "Reading";

  const close = () => {
    setDropOwn(false);
    onClose();
  };
  const act = async (run: boolean) => {
    setBusy(run ? "run" : "clear");
    try {
      if (run && scope === "book") await post(`${base}/phase2/rebuild`, { dropOwn });
      else await post(`${base}/kb/clear`, { dropOwn, learn: run });
      await refreshKnowledge(client, pid, targetId);
      notifications.show({
        color: "green",
        message: run
          ? `Knowledge base cleared; ${phase} has started.`
          : "Knowledge base cleared. A copy was saved.",
      });
      close();
      if (run)
        navigate(
          `/projects/${pid}/${scope === "pair" ? "pairs" : "books"}/${targetId}/${scope === "pair" ? "learn" : "read"}`,
        );
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't start over",
        message: (e as Error).message,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title="Start over with an empty knowledge base"
      size="lg"
    >
      <Stack>
        <Text size="sm">
          The knowledge base is emptied
          {scope === "book" ? ", with phase 2's chapter notes" : ""}. A copy is saved first, with
          your changes, so you can restore it{" "}
          {scope === "pair" ? "under Earlier versions on the Knowledge base page" : "in History"}.
          {scope === "book"
            ? " Your translation isn't changed; translate again to use the new knowledge base."
            : " Until Learning runs again, books that use this pair get only your own entries from it, or nothing if you drop them."}
        </Text>
        <Text size="sm">
          The next {phase} run reads every chapter again and asks the models anew instead of
          repeating their earlier answers, so it costs a full run.{costText ? ` ${costText}` : ""}
        </Text>
        <Checkbox
          label="Also drop my own changes"
          description={
            own.length > 0
              ? `Kept unless you tick this: ${listText(own)}. The saved copy has them either way.`
              : "You haven't changed anything in this knowledge base."
          }
          disabled={own.length === 0}
          checked={dropOwn}
          onChange={(e) => setDropOwn(e.currentTarget.checked)}
        />
        {!confirmed && (
          <Alert color="yellow">
            Confirm the pair's chapter alignment before learning again. You can clear the knowledge
            base now and learn later.
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="default"
            loading={busy === "clear"}
            disabled={busy !== null}
            onClick={() => act(false)}
          >
            Clear
          </Button>
          <Button
            loading={busy === "run"}
            disabled={busy !== null || !confirmed}
            onClick={() => act(true)}
          >
            {scope === "pair" ? "Clear and learn again" : "Clear and read again"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface PairSavedKnowledge {
  id: string;
  number: number;
  savedAt: string;
  reason: "clear" | "restore";
  entries: number;
  open: number;
  locked: number;
}

const REASONS: Record<PairSavedKnowledge["reason"], string> = {
  clear: "when the knowledge base was cleared",
  restore: "before another knowledge base was restored",
};

/** A pair's saved knowledge bases, with Restore. */
export function PairVersionsModal({
  pid,
  pairId,
  opened,
  busy,
  onClose,
}: {
  pid: string;
  pairId: string;
  opened: boolean;
  /** A job is running for the pair. */
  busy: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [restoring, setRestoring] = useState<string | null>(null);
  const history = usePairVersions(pid, pairId);
  const restore = async (k: PairSavedKnowledge) => {
    if (
      !window.confirm(
        `Make knowledge base ${k.number} this pair's knowledge base again, with your changes from then? The current one is saved here first.`,
      )
    )
      return;
    setRestoring(k.id);
    try {
      await post(`/api/projects/${pid}/pairs/${pairId}/kb/history/${k.id}/restore`);
      await refreshKnowledge(client, pid, pairId);
      notifications.show({ color: "green", message: `Knowledge base ${k.number} restored.` });
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't restore",
        message: (e as Error).message,
      });
    } finally {
      setRestoring(null);
    }
  };
  const list = [...(history.data?.knowledgeBases ?? [])].reverse();
  return (
    <Modal opened={opened} onClose={onClose} title="Earlier versions" size="lg">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          A copy of the knowledge base is saved each time you start over, and before an earlier one
          is restored. Restoring brings back its entries, your changes from then and what Learning
          found in each chapter.
        </Text>
        {list.map((k) => {
          const current = history.data?.current === k.id;
          return (
            <Box key={k.id} className="tr-history-entry">
              <Group justify="space-between" align="flex-start" gap="md" wrap="nowrap">
                <Stack gap={2} style={{ minWidth: 0 }}>
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
                    Saved {formatDate(k.savedAt)}, {REASONS[k.reason]}.
                  </Text>
                  <Text size="sm">
                    {plural(k.entries, "entry", "entries")}, {plural(k.open, "open question")},{" "}
                    {k.locked.toLocaleString()} set by you.
                  </Text>
                </Stack>
                {!current && (
                  <Button
                    size="xs"
                    variant="default"
                    loading={restoring === k.id}
                    disabled={busy || (restoring !== null && restoring !== k.id)}
                    onClick={() => restore(k)}
                  >
                    Restore
                  </Button>
                )}
              </Group>
            </Box>
          );
        })}
      </Stack>
    </Modal>
  );
}

/** The pair's saved knowledge bases. */
export function usePairVersions(pid: string, pairId: string, enabled = true) {
  return useQuery({
    queryKey: ["target", pairId, "kb-history"],
    queryFn: () =>
      get<{ knowledgeBases: PairSavedKnowledge[]; current: string | null }>(
        `/api/projects/${pid}/pairs/${pairId}/kb/history`,
      ),
    enabled,
  });
}
