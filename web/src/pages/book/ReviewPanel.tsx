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
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowBackUp,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPencil,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { del, get, put } from "../../api/client.ts";
import { useWidePage } from "../../components/Layout.tsx";
import { type Highlight, UnitText } from "../../components/PlaceholderText.tsx";
import { displayTitle, formatDate, plural } from "../../lib/format.ts";
import { useSourceName } from "../ProjectPage.tsx";
import { MIN_QUERY, ReviewSearch, type SearchResult, type SearchScope } from "./ReviewSearch.tsx";
import { RewriteModal } from "./RewriteModal.tsx";
import type { HistoryView, ReviewUnit } from "./types.ts";

/** A chapter in the list, with how many passages differ between the versions shown. */
interface ReviewChapter {
  id: string;
  title: string;
  units: number;
  /** Null with fewer than two versions shown. */
  different: number | null;
}

const CHAPTERS_KEY = "tr-review-chapters";
const DIFFERENCES_KEY = "tr-review-differences";

/** The chapter list beside the columns; collapses to a narrow strip. */
function ChapterList({
  list,
  selected,
  collapsed,
  showDifferences,
  onToggle,
  onSelect,
}: {
  list: ReviewChapter[];
  selected: string | null;
  collapsed: boolean;
  /** Count the passages that differ between the versions. */
  showDifferences: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
}) {
  // Keep the open chapter in view when it changes (arrows, links).
  useEffect(() => {
    if (!collapsed && selected)
      document.querySelector(".tr-review .tr-chapter[data-active]")?.scrollIntoView({
        block: "nearest",
      });
  }, [selected, collapsed]);
  if (collapsed)
    return (
      <div className="tr-chapters">
        <Tooltip label="Show the chapters" position="right">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Show the chapters"
            onClick={onToggle}
          >
            <IconLayoutSidebarLeftExpand size={18} stroke={1.6} />
          </ActionIcon>
        </Tooltip>
      </div>
    );
  return (
    <nav className="tr-chapters" aria-label="Chapters">
      <Group justify="space-between" wrap="nowrap" pl={12} mb={6}>
        <Text size="sm" fw={600}>
          Chapters
        </Text>
        <Tooltip label="Hide the chapters" position="right">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Hide the chapters"
            onClick={onToggle}
          >
            <IconLayoutSidebarLeftCollapse size={16} stroke={1.6} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {list.map((c) => (
        <button
          key={c.id}
          type="button"
          className="tr-chapter"
          data-active={c.id === selected || undefined}
          aria-current={c.id === selected ? "true" : undefined}
          onClick={() => onSelect(c.id)}
        >
          <div className="tr-chapter-title">{displayTitle(c.title)}</div>
          <div className="tr-chapter-meta">
            {plural(c.units, "passage")}
            {showDifferences &&
              c.different !== null &&
              (c.different > 0 ? (
                <Text span size="xs" c="var(--tr-ochre)">
                  , {c.different} different
                </Text>
              ) : (
                ", the same"
              ))}
          </div>
        </button>
      ))}
    </nav>
  );
}

const SOURCE = "source";
const CURRENT = "current";
const MAX_COLUMNS = 3;

interface Column {
  id: string;
  label: string;
}

/** Narrowest a column may get, as a share of the page's width. */
const MIN_SHARE = 0.12;
/** The space between columns, in pixels (as in the stylesheet). */
const GAP = 28;

/**
 * Changes one column's width by `delta` (a share of the page's width). The
 * others stay as they are, so together they never get wider than the page;
 * space given up stays empty on the right.
 */
function resizeColumn(shares: number[], i: number, delta: number): number[] {
  const others = shares.reduce((sum, s, j) => (j === i ? sum : sum + s), 0);
  const next = [...shares];
  next[i] = Math.min(1 - others, Math.max(MIN_SHARE, shares[i]! + delta));
  return next;
}

/** Starting widths: one column at a comfortable reading width, several sharing the page. */
function defaultShares(count: number): number[] {
  return count === 1 ? [0.6] : Array.from({ length: count }, () => 1 / count);
}

/** Column widths as shares of the page's width, remembered in this browser per number of columns. */
function useColumnShares(count: number) {
  const key = `tr-review-widths-${count}`;
  const even = () => defaultShares(count);
  const read = (): number[] => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      if (
        Array.isArray(saved) &&
        saved.length === count &&
        saved.every((x) => typeof x === "number" && x >= MIN_SHARE) &&
        saved.reduce((a: number, b: number) => a + b, 0) <= 1.001
      )
        return saved as number[];
    } catch {
      // No storage here (private window, blocked site data): equal widths.
    }
    return even();
  };
  const [shares, setShares] = useState<number[]>(read);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the number of columns changes
  useEffect(() => setShares(read()), [count]);
  const save = (next: number[]) => {
    setShares(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Not remembered, but still applied.
    }
  };
  return { shares, setShares, save, reset: () => save(even()) };
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
  highlight,
  onEdit,
  onCopy,
  onRevert,
}: {
  unit: ReviewUnit;
  column: Column;
  /** The other versions shown, to copy this passage to. */
  others: Column[];
  showTags: boolean;
  /** The text being searched for, marked where it occurs. */
  highlight?: Highlight;
  onEdit: () => void;
  onCopy: (to: Column) => void;
  onRevert: () => void;
}) {
  if (column.id === SOURCE)
    return (
      <div className="tr-cmp-cell" data-kind="source">
        <div className="tr-cmp-label">{column.label}</div>
        <UnitText
          text={unit.source}
          placeholders={unit.placeholders}
          showTags={showTags}
          highlight={highlight}
        />
      </div>
    );
  const cell = unit.versions[column.id];
  return (
    <div className="tr-cmp-cell" data-kind="version">
      <div className="tr-cmp-label">{column.label}</div>
      {cell?.text ? (
        <UnitText
          text={cell.text}
          placeholders={unit.placeholders}
          showTags={showTags}
          highlight={highlight}
        />
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
  const source = useSourceName(pid);
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [showTags, setShowTags] = useState(false);
  const [markDifferences, setMarkDifferences] = useState(() => {
    try {
      return localStorage.getItem(DIFFERENCES_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const toggleDifferences = (on: boolean) => {
    setMarkDifferences(on);
    try {
      localStorage.setItem(DIFFERENCES_KEY, on ? "on" : "off");
    } catch {
      // Not remembered, but still applied.
    }
  };
  const [filter, setFilter] = useState<"all" | "different">("all");
  const [editing, setEditing] = useState<{ unit: ReviewUnit; version: Column } | null>(null);
  // Search: opened with the button or Ctrl+F, listed on the right.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced] = useDebouncedValue(query, 300);
  const [scope, setScope] = useState<SearchScope>("chapter");
  const [exact, setExact] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [searchedChoice, setSearched] = useState<string[] | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  /** A passage to bring into view once its chapter is loaded. */
  const [target, setTarget] = useState<{ key: string } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  };
  // Ctrl+F (Cmd+F) opens this search instead of the browser's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInput.current?.focus();
          searchInput.current?.select();
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(CHAPTERS_KEY) === "hidden";
    } catch {
      return false;
    }
  });
  const toggleChapters = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(CHAPTERS_KEY, c ? "shown" : "hidden");
      } catch {
        // Not remembered, but still applied.
      }
      return !c;
    });
  const history = useQuery({
    queryKey: ["target", bookId, "history"],
    queryFn: () => get<HistoryView>(`/api/projects/${pid}/books/${bookId}/history`),
  });
  const saved = [...(history.data?.translations ?? [])].reverse();
  const savedAs = history.data?.current?.savedAs ?? null;
  const labelOf = (id: string): string => {
    if (id === SOURCE) return source;
    if (id === CURRENT) return "Current translation";
    const t = saved.find((x) => x.id === id);
    return t ? `Translation ${t.number}` : "Saved translation";
  };
  const options = [
    { value: SOURCE, label: source },
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
  // The whole window, so columns can be made as wide as you like.
  useWidePage(true);
  const widths = useColumnShares(columns.length);
  const headRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  /** Drags the right edge of column `i`. */
  const startDrag = (e: React.PointerEvent<HTMLDivElement>, i: number) => {
    e.preventDefault();
    const usable = Math.max(
      1,
      (headRef.current?.getBoundingClientRect().width ?? 1) - (columns.length - 1) * GAP,
    );
    const startX = e.clientX;
    const start = widths.shares;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(i);
    const at = (ev: PointerEvent) => resizeColumn(start, i, (ev.clientX - startX) / usable);
    const move = (ev: PointerEvent) => widths.setShares(at(ev));
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      setDragging(null);
      widths.save(at(ev));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  const versions = cols.filter((c) => c !== SOURCE);
  const chapters = useQuery({
    queryKey: ["target", bookId, "review-chapters", versions.join(",")],
    queryFn: () =>
      get<{ chapters: ReviewChapter[] }>(
        `/api/projects/${pid}/books/${bookId}/review/chapters?versions=${versions.join(",")}`,
      ),
  });
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };
  const setCols = (next: string[]) => setParam("cols", next.join(","));

  const list = chapters.data?.chapters ?? [];
  const chapterId =
    params.get("chapter") ?? (list.find((c) => c.units >= 20) ?? list[0])?.id ?? null;
  const at = list.findIndex((c) => c.id === chapterId);
  const go = (id: string) => {
    setParam("chapter", id);
    window.scrollTo({ top: 0 });
  };

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
  // By default every open column is searched.
  const searchedIds = (searchedChoice ?? cols).filter((id) => cols.includes(id));
  const searched = searchedIds.length > 0 ? searchedIds : cols;
  const highlightFor = (id: string): Highlight | undefined =>
    searchOpen && debounced.trim().length >= MIN_QUERY && searched.includes(id)
      ? { query: debounced, exact, wholeWord }
      : undefined;
  const pick = (r: SearchResult) => {
    if (r.chapterId !== chapterId) setParam("chapter", r.chapterId);
    // The passage may read the same in every version.
    if (filter === "different") setFilter("all");
    setTarget({ key: r.key });
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
  // Bring a picked search result into view, once its chapter has loaded.
  useEffect(() => {
    if (!target) return;
    const index = units.findIndex((u) => u.key === target.key);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center" });
    setFocused(target.key);
    setTarget(null);
  }, [target, units, virtualizer]);
  useEffect(() => {
    if (!focused) return;
    const t = setTimeout(() => setFocused(null), 2500);
    return () => clearTimeout(t);
  }, [focused]);

  if (chapters.isLoading) return <Loader size="sm" />;
  if (list.length === 0)
    return (
      <Text size="md" c="dimmed">
        Nothing is translated yet. Translate the book first; its chapters appear here.
      </Text>
    );

  const grid = {
    "--tr-cols-template": widths.shares
      .map((s) => `calc((100% - ${(columns.length - 1) * GAP}px) * ${s.toFixed(4)})`)
      .join(" "),
  } as React.CSSProperties;
  const current = list[at];
  return (
    <Box
      className="tr-review"
      data-collapsed={collapsed || undefined}
      data-search={searchOpen || undefined}
    >
      <ChapterList
        list={list}
        selected={chapterId}
        collapsed={collapsed}
        showDifferences={markDifferences}
        onToggle={toggleChapters}
        onSelect={go}
      />
      <Box style={{ minWidth: 0 }}>
        <Group justify="space-between" gap="md" mb="md" wrap="wrap">
          <Group gap={6} wrap="nowrap" style={{ flex: "1 1 420px", minWidth: 0 }}>
            <ActionIcon
              variant="default"
              aria-label="Previous chapter"
              disabled={at <= 0}
              onClick={() => go(list[at - 1]!.id)}
            >
              <IconChevronLeft size={16} />
            </ActionIcon>
            <ActionIcon
              variant="default"
              aria-label="Next chapter"
              disabled={at < 0 || at >= list.length - 1}
              onClick={() => go(list[at + 1]!.id)}
            >
              <IconChevronRight size={16} />
            </ActionIcon>
            <Text className="serif" fw={600} size="lg" truncate ml={6}>
              {current ? displayTitle(current.title) : ""}
            </Text>
          </Group>
          <Group gap="lg">
            <Tooltip label="Ctrl+F">
              <Button
                size="xs"
                variant="default"
                leftSection={<IconSearch size={14} />}
                onClick={openSearch}
              >
                Search
              </Button>
            </Tooltip>
            {versions.length > 1 && (
              <Switch
                size="xs"
                label="Mark differences"
                checked={markDifferences}
                onChange={(e) => toggleDifferences(e.currentTarget.checked)}
              />
            )}
            <Switch
              size="xs"
              label="Show tags"
              checked={showTags}
              onChange={(e) => setShowTags(e.currentTarget.checked)}
            />
          </Group>
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
              onClick={() =>
                setCols([...cols, options.find((o) => !cols.includes(o.value))!.value])
              }
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

        <div className="tr-cmp-head" style={grid} ref={headRef}>
          {columns.map((c, i) => (
            <div key={c.id} className="tr-cmp-title">
              {c.label}
              {/* biome-ignore lint/a11y/useSemanticElements: a draggable column edge, not a rule */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Width of ${c.label}`}
                aria-valuenow={Math.round(widths.shares[i]! * 100)}
                aria-valuemin={Math.round(MIN_SHARE * 100)}
                aria-valuemax={100}
                tabIndex={0}
                title="Drag to change this column's width; double-click to reset all"
                className="tr-cmp-resize"
                data-dragging={dragging === i || undefined}
                onPointerDown={(e) => startDrag(e, i)}
                onDoubleClick={widths.reset}
                onKeyDown={(e) => {
                  const step = e.key === "ArrowLeft" ? -0.02 : e.key === "ArrowRight" ? 0.02 : 0;
                  if (!step) return;
                  e.preventDefault();
                  widths.save(resizeColumn(widths.shares, i, step));
                }}
              />
            </div>
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
                data-focused={focused === unit.key || undefined}
                data-differs={
                  (markDifferences && versions.length > 1 && differs(unit, versions)) || undefined
                }
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
                    highlight={highlightFor(col.id)}
                    onEdit={() => setEditing({ unit, version: col })}
                    onCopy={(to) => copy(unit, col, to)}
                    onRevert={() => revert(unit, col)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </Box>
      {searchOpen && (
        <ReviewSearch
          pid={pid}
          bookId={bookId}
          chapterId={chapterId}
          columns={columns}
          query={query}
          onQuery={setQuery}
          debounced={debounced}
          scope={scope}
          onScope={setScope}
          searched={searched}
          onSearched={setSearched}
          exact={exact}
          onExact={setExact}
          wholeWord={wholeWord}
          onWholeWord={setWholeWord}
          onReplaced={refresh}
          inputRef={searchInput}
          onPick={pick}
          onClose={() => setSearchOpen(false)}
        />
      )}
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
