import {
  ActionIcon,
  Box,
  Button,
  CloseButton,
  Group,
  Loader,
  Menu,
  SegmentedControl,
  Select,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowBackUp,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconPencil,
  IconPlus,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { del, get, put } from "../../api/client.ts";
import { useWidePage } from "../../components/Layout.tsx";
import { UnitText } from "../../components/PlaceholderText.tsx";
import { displayTitle, formatDate, plural } from "../../lib/format.ts";
import { RewriteModal } from "./RewriteModal.tsx";
import type { ChapterView, HistoryView, ReviewUnit } from "./types.ts";

const SOURCE = "source";
const CURRENT = "current";
const MAX_COLUMNS = 3;

interface Column {
  id: string;
  label: string;
}

/** True when the versions shown don't all have the same text. */
function differs(unit: ReviewUnit, versions: string[]): boolean {
  const texts = versions.map((v) => unit.versions[v]?.text ?? null);
  return texts.some((t) => t !== texts[0]);
}

function Cell({
  unit,
  column,
  others,
  showTags,
  onEdit,
  onCopy,
  onRevert,
}: {
  unit: ReviewUnit;
  column: Column;
  /** The other versions shown, to copy this passage to. */
  others: Column[];
  showTags: boolean;
  onEdit: () => void;
  onCopy: (to: Column) => void;
  onRevert: () => void;
}) {
  if (column.id === SOURCE)
    return (
      <div className="tr-cmp-cell" data-kind="source">
        <div className="tr-cmp-label">{column.label}</div>
        <UnitText text={unit.source} placeholders={unit.placeholders} showTags={showTags} />
      </div>
    );
  const cell = unit.versions[column.id];
  return (
    <div className="tr-cmp-cell" data-kind="version">
      <div className="tr-cmp-label">{column.label}</div>
      {cell?.text ? (
        <UnitText text={cell.text} placeholders={unit.placeholders} showTags={showTags} />
      ) : (
        <div className="tr-page-text tr-pending">
          {cell?.status === "refused" ? "The model refused this passage." : "Not translated."}
        </div>
      )}
      {cell?.status === "flagged" && (
        <div className="tr-note" data-kind="attention">
          Needs attention.
        </div>
      )}
      {cell?.edited && (
        <div className="tr-note" data-kind="edited">
          Edited by you.
        </div>
      )}
      <div className="tr-cmp-actions">
        <Tooltip label="Edit or rewrite" position="left">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`Edit or rewrite in ${column.label}`}
            onClick={onEdit}
          >
            <IconPencil size={15} stroke={1.7} />
          </ActionIcon>
        </Tooltip>
        {cell?.text && others.length > 0 && (
          <Menu position="left-start" withArrow>
            <Menu.Target>
              <Tooltip label="Copy to another version" position="left">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label={`Copy from ${column.label}`}
                >
                  <IconCopy size={15} stroke={1.7} />
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Copy this passage to</Menu.Label>
              {others.map((o) => (
                <Menu.Item key={o.id} onClick={() => onCopy(o)}>
                  {o.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
        {cell?.edited && (
          <Tooltip label="Back to the AI translation" position="left">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Back to the AI translation in ${column.label}`}
              onClick={onRevert}
            >
              <IconArrowBackUp size={15} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/**
 * Up to three versions side by side, passage by passage: the original, the
 * current translation and saved ones. Any translation can be edited by hand,
 * rewritten by a model, or take a passage from another version.
 */
export function ReviewPanel({ pid, bookId }: { pid: string; bookId: string }) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [showTags, setShowTags] = useState(false);
  const [filter, setFilter] = useState<"all" | "different">("all");
  const [editing, setEditing] = useState<{ unit: ReviewUnit; version: Column } | null>(null);

  const chapters = useQuery({
    queryKey: ["target", bookId, "chapters"],
    queryFn: () =>
      get<{ chapters: ChapterView[] }>(`/api/projects/${pid}/books/${bookId}/chapters`),
  });
  const history = useQuery({
    queryKey: ["target", bookId, "history"],
    queryFn: () => get<HistoryView>(`/api/projects/${pid}/books/${bookId}/history`),
  });
  const saved = [...(history.data?.translations ?? [])].reverse();
  const savedAs = history.data?.current?.savedAs ?? null;
  const labelOf = (id: string): string => {
    if (id === SOURCE) return "English";
    if (id === CURRENT) return "Current translation";
    const t = saved.find((x) => x.id === id);
    return t ? `Translation ${t.number}` : "Saved translation";
  };
  const options = [
    { value: SOURCE, label: "English" },
    { value: CURRENT, label: "Current translation" },
    ...saved.map((t) => ({
      value: t.id,
      label: `Translation ${t.number}, ${formatDate(t.savedAt)}${t.id === savedAs ? " (current)" : ""}`,
    })),
  ];

  const known = (id: string) =>
    id === SOURCE || id === CURRENT || !history.data || saved.some((t) => t.id === id);
  const ids = [
    ...new Set((params.get("cols") ?? `${SOURCE},${CURRENT}`).split(",").filter(known)),
  ].slice(0, MAX_COLUMNS);
  const cols = ids.length > 0 ? ids : [SOURCE, CURRENT];
  const columns: Column[] = cols.map((id) => ({ id, label: labelOf(id) }));
  // Side by side, the versions get the whole window; one column keeps the reading width.
  useWidePage(columns.length > 1);
  const versions = cols.filter((c) => c !== SOURCE);
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };
  const setCols = (next: string[]) => setParam("cols", next.join(","));

  const list = (chapters.data?.chapters ?? []).filter((c) => c.units > 0);
  const chapterId =
    params.get("chapter") ?? (list.find((c) => c.units >= 20) ?? list[0])?.id ?? null;
  const at = list.findIndex((c) => c.id === chapterId);

  // With only the original shown, the current translation is loaded anyway (and not shown).
  const loaded = versions.length > 0 ? versions : [CURRENT];
  const key = ["target", bookId, "review", chapterId, loaded.join(",")];
  const review = useQuery({
    queryKey: key,
    enabled: chapterId !== null,
    queryFn: () =>
      get<{ units: ReviewUnit[] }>(
        `/api/projects/${pid}/books/${bookId}/chapters/${chapterId}/review?versions=${loaded.join(",")}`,
      ),
  });
  const all = review.data?.units ?? [];
  const different = useMemo(
    () => (versions.length > 1 ? all.filter((u) => differs(u, versions)) : []),
    [all, versions],
  );
  const units = filter === "different" && versions.length > 1 ? different : all;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["target", bookId] });
  };

  const copy = async (unit: ReviewUnit, from: Column, to: Column) => {
    try {
      await put(`/api/projects/${pid}/books/${bookId}/versions/${to.id}/units/${unit.urlKey}`, {
        text: unit.versions[from.id]?.text ?? "",
      });
      notifications.show({ color: "green", message: `Copied to ${to.label}.` });
      refresh();
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't copy", message: (e as Error).message });
    }
  };
  const revert = async (unit: ReviewUnit, column: Column) => {
    try {
      await del(
        `/api/projects/${pid}/books/${bookId}/versions/${column.id}/units/${unit.urlKey}/edit`,
      );
      notifications.show({ message: `${column.label}: back to the AI translation.` });
      refresh();
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't undo", message: (e as Error).message });
    }
  };

  const listRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    if (listRef.current) setOffset(listRef.current.getBoundingClientRect().top + window.scrollY);
  });
  const virtualizer = useWindowVirtualizer({
    count: units.length,
    getItemKey: (i) => units[i]?.key ?? i,
    estimateSize: () => 140,
    overscan: 6,
    scrollMargin: offset,
  });

  if (chapters.isLoading) return <Loader size="sm" />;
  if (list.length === 0)
    return (
      <Text size="md" c="dimmed">
        Nothing is translated yet. Translate the book first; its chapters appear here.
      </Text>
    );

  const grid = { "--tr-cols": columns.length } as React.CSSProperties;
  return (
    <Box>
      <Group justify="space-between" gap="md" mb="md" wrap="wrap">
        <Group gap={6} wrap="nowrap" style={{ flex: "1 1 420px", minWidth: 0 }}>
          <ActionIcon
            variant="default"
            aria-label="Previous chapter"
            disabled={at <= 0}
            onClick={() => setParam("chapter", list[at - 1]!.id)}
          >
            <IconChevronLeft size={16} />
          </ActionIcon>
          <Select
            aria-label="Chapter"
            searchable
            allowDeselect={false}
            value={chapterId}
            onChange={(v) => v && setParam("chapter", v)}
            data={list.map((c) => ({
              value: c.id,
              label: `${displayTitle(c.title)} (${plural(c.units, "passage")})`,
            }))}
            style={{ flex: 1, minWidth: 0 }}
          />
          <ActionIcon
            variant="default"
            aria-label="Next chapter"
            disabled={at < 0 || at >= list.length - 1}
            onClick={() => setParam("chapter", list[at + 1]!.id)}
          >
            <IconChevronRight size={16} />
          </ActionIcon>
        </Group>
        <Switch
          size="xs"
          label="Show tags"
          checked={showTags}
          onChange={(e) => setShowTags(e.currentTarget.checked)}
        />
      </Group>

      <Group gap="sm" mb="md" wrap="wrap" align="center">
        {columns.map((col, i) => (
          <Group key={col.id} gap={2} wrap="nowrap">
            <Select
              aria-label={`Column ${i + 1}`}
              size="xs"
              w={290}
              allowDeselect={false}
              value={col.id}
              data={options.filter((o) => o.value === col.id || !cols.includes(o.value))}
              onChange={(v) => v && setCols(cols.map((c) => (c === col.id ? v : c)))}
            />
            {columns.length > 1 && (
              <CloseButton
                size="sm"
                aria-label={`Remove column ${i + 1}`}
                onClick={() => setCols(cols.filter((c) => c !== col.id))}
              />
            )}
          </Group>
        ))}
        {columns.length < MAX_COLUMNS && options.some((o) => !cols.includes(o.value)) && (
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconPlus size={14} />}
            onClick={() => setCols([...cols, options.find((o) => !cols.includes(o.value))!.value])}
          >
            Add column
          </Button>
        )}
        {versions.length > 1 && (
          <SegmentedControl
            size="xs"
            ml="auto"
            value={filter}
            onChange={(v) => setFilter(v as "all" | "different")}
            data={[
              { value: "all", label: `All ${all.length}` },
              { value: "different", label: `Different ${different.length}` },
            ]}
          />
        )}
      </Group>

      <div className="tr-cmp-head" style={grid}>
        {columns.map((c) => (
          <div key={c.id}>{c.label}</div>
        ))}
      </div>
      {review.isLoading && <Loader size="sm" />}
      {review.data && units.length === 0 && (
        <Text size="md" c="dimmed" py="xl">
          {filter === "different"
            ? "The versions shown are the same in this chapter."
            : "This chapter has no text."}
        </Text>
      )}
      <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const unit = units[item.index]!;
          return (
            <div
              key={unit.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="tr-spread-row tr-cmp-row"
              data-role={unit.role}
              data-differs={(versions.length > 1 && differs(unit, versions)) || undefined}
              style={{
                ...grid,
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {columns.map((col) => (
                <Cell
                  key={col.id}
                  unit={unit}
                  column={col}
                  others={columns.filter((o) => o.id !== col.id && o.id !== SOURCE)}
                  showTags={showTags}
                  onEdit={() => setEditing({ unit, version: col })}
                  onCopy={(to) => copy(unit, col, to)}
                  onRevert={() => revert(unit, col)}
                />
              ))}
            </div>
          );
        })}
      </div>
      <RewriteModal
        pid={pid}
        bookId={bookId}
        unit={editing?.unit ?? null}
        version={editing?.version ?? null}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
    </Box>
  );
}
