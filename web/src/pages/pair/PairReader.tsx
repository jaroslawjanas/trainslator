import { ActionIcon, Alert, Group, Loader, Switch, Text, Tooltip } from "@mantine/core";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AlignUnit } from "../../../../src/shared/schemas/alignment.ts";
import type { Segment } from "../../../../src/shared/schemas/epub.ts";
import { get } from "../../api/client.ts";
import { useWidePage } from "../../components/Layout.tsx";
import { TextLoading } from "../../components/Loading.tsx";
import { type PlaceholderInfo, UnitText } from "../../components/PlaceholderText.tsx";
import { displayTitle, plural } from "../../lib/format.ts";
import { useSourceName } from "../ProjectPage.tsx";

interface Passage {
  role: string;
  inFootnote: boolean;
  text: string;
  placeholders: PlaceholderInfo[];
}

interface PairText {
  source: { titles: string[]; words: number; passages: number };
  target: { titles: string[]; words: number; passages: number };
  rows: { source: Passage[]; target: Passage[] }[];
}

/** How long the translation of a row is compared with the pair as a whole, or null. */
export function relativeLength(
  unit: AlignUnit,
  sourceSegs: Map<string, Segment>,
  targetSegs: Map<string, Segment>,
  ratio: number,
): number | null {
  const words = (ids: string[], map: Map<string, Segment>) =>
    ids.reduce((s, id) => s + (map.get(id)?.words ?? 0), 0);
  const a = words(unit.source, sourceSegs);
  const b = words(unit.target, targetSegs);
  return a > 0 && b > 0 ? b / ratio / a : null;
}

const titles = (ids: string[], map: Map<string, Segment>) =>
  ids.map((id) => displayTitle(map.get(id)?.title ?? id)).join(" + ");

function Passages({
  passages,
  label,
  showTags,
}: {
  passages: Passage[];
  label: string;
  showTags: boolean;
}) {
  return (
    <div className="tr-cmp-cell" data-alone={passages.length === 0 || undefined}>
      <div className="tr-cmp-label">{label}</div>
      {passages.length === 0 ? (
        <div className="tr-read-none">—</div>
      ) : (
        passages.map((p, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: passages of a row never move
            key={i}
            className="tr-read-passage"
            data-role={p.role}
            data-note={p.inFootnote || undefined}
          >
            <UnitText text={p.text} placeholders={p.placeholders} showTags={showTags} />
          </div>
        ))
      )}
    </div>
  );
}

/**
 * A reference pair side by side, one row of the alignment at a time: the
 * original on the left, the translation on the right, passages lined up.
 * Reads the rows as they are in the table, saved or not.
 */
export function PairReader({
  pid,
  pairId,
  units,
  sourceSegs,
  targetSegs,
  ratio,
  rowId,
  onRow,
}: {
  pid: string;
  pairId: string;
  units: AlignUnit[];
  sourceSegs: Map<string, Segment>;
  targetSegs: Map<string, Segment>;
  ratio: number;
  rowId: string | null;
  onRow: (id: string) => void;
}) {
  useWidePage(true);
  const source = useSourceName(pid);
  const [showTags, setShowTags] = useState(false);
  // With no row asked for, open the first one that is used and has text on both sides.
  const asked = units.findIndex((u) => u.id === rowId);
  const firstUsed = units.findIndex((u) => u.include && u.source.length > 0 && u.target.length > 0);
  const at = asked >= 0 ? asked : Math.max(0, firstUsed);
  const unit = units[at];
  const query = useQuery({
    queryKey: ["pair", pairId, "text", unit?.source.join(","), unit?.target.join(",")],
    queryFn: () =>
      get<PairText>(
        `/api/projects/${pid}/pairs/${pairId}/text?source=${unit!.source.join(",")}&target=${unit!.target.join(",")}`,
      ),
    enabled: Boolean(unit),
    placeholderData: keepPreviousData,
  });
  const rows = query.data?.rows ?? [];

  // Keep the open row in view in the list when it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the row changes
  useEffect(() => {
    document.querySelector(".tr-review .tr-chapter[data-active]")?.scrollIntoView({
      block: "nearest",
    });
  }, [at]);

  const listRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    if (listRef.current) setOffset(listRef.current.getBoundingClientRect().top + window.scrollY);
  });
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 120,
    overscan: 6,
    scrollMargin: offset,
  });
  // A new row starts at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the row changes
  useEffect(() => {
    if (window.scrollY > offset) window.scrollTo({ top: Math.max(0, offset - 160) });
  }, [at]);

  if (!unit)
    return (
      <Text size="md" c="dimmed">
        The alignment has no rows.
      </Text>
    );

  const go = (i: number) => {
    const next = units[i];
    if (next) onRow(next.id);
  };
  const lone = rows.filter((r) => r.source.length === 0 || r.target.length === 0).length;

  return (
    <div className="tr-review">
      <nav className="tr-chapters" aria-label="Rows of the alignment">
        <Text size="sm" fw={600} pl={12} mb={6}>
          Rows
        </Text>
        {units.map((u, i) => {
          const rel = relativeLength(u, sourceSegs, targetSegs, ratio);
          return (
            <button
              key={u.id}
              type="button"
              className="tr-chapter"
              data-active={i === at || undefined}
              aria-current={i === at ? "true" : undefined}
              onClick={() => onRow(u.id)}
              style={{ opacity: u.include ? 1 : 0.6 }}
            >
              <div className="tr-chapter-title">
                {u.source.length > 0 ? titles(u.source, sourceSegs) : "—"}
              </div>
              <div className="tr-chapter-meta">
                {u.target.length > 0 ? titles(u.target, targetSegs) : "nothing in the translation"}
              </div>
              <div className="tr-chapter-meta">
                {!u.include && "not used, "}
                {rel === null ? "one side" : `length ${Math.round(rel * 100)}%`}
              </div>
            </button>
          );
        })}
      </nav>
      <div style={{ minWidth: 0 }}>
        <Group justify="space-between" gap="md" mb="xs" wrap="wrap">
          <Group gap={6} wrap="nowrap" style={{ flex: "1 1 420px", minWidth: 0 }}>
            <ActionIcon
              variant="default"
              aria-label="Previous row"
              disabled={at <= 0}
              onClick={() => go(at - 1)}
            >
              <IconChevronLeft size={16} />
            </ActionIcon>
            <ActionIcon
              variant="default"
              aria-label="Next row"
              disabled={at >= units.length - 1}
              onClick={() => go(at + 1)}
            >
              <IconChevronRight size={16} />
            </ActionIcon>
            <Text className="serif" fw={600} size="lg" truncate ml={6}>
              {titles(unit.source, sourceSegs) || titles(unit.target, targetSegs)}
            </Text>
            {query.isFetching && <Loader size="xs" ml="xs" />}
          </Group>
          <Switch
            size="xs"
            label="Show tags"
            checked={showTags}
            onChange={(e) => setShowTags(e.currentTarget.checked)}
          />
        </Group>
        <Text size="sm" c="dimmed" mb="md" maw={720}>
          Passages are lined up by their length and the names they share, so a row can pair passages
          that don't belong together. If the two sides drift apart for a whole chapter, the chapters
          don't match, or the text of one book is damaged.
          {query.data && lone > 0 && ` ${plural(lone, "passage")} found no partner here.`}
        </Text>
        {query.error && <Alert color="red">{(query.error as Error).message}</Alert>}
        <div className="tr-cmp-head">
          <div className="tr-cmp-title">
            {source}
            {query.data &&
              `: ${plural(query.data.source.passages, "passage")}, ${query.data.source.words.toLocaleString()} words`}
          </div>
          <div className="tr-cmp-title">
            Translation
            {query.data &&
              `: ${plural(query.data.target.passages, "passage")}, ${query.data.target.words.toLocaleString()} words`}
          </div>
        </div>
        {query.isLoading && <TextLoading />}
        <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="tr-cmp-row tr-read-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                <Passages passages={row.source} label={source} showTags={showTags} />
                <Passages passages={row.target} label="Translation" showTags={showTags} />
              </div>
            );
          })}
        </div>
        {query.data && rows.length > 0 && (
          <Group justify="center" mt="xl">
            <Tooltip label="Next row" disabled={at >= units.length - 1}>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Next row"
                disabled={at >= units.length - 1}
                onClick={() => go(at + 1)}
              >
                <IconChevronRight size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </div>
    </div>
  );
}
