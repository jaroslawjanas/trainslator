import {
  Alert,
  Box,
  Button,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { languageDisplayName } from "../../../../src/shared/languages.ts";
import type { KbEntry } from "../../../../src/shared/schemas/kb.ts";
import { del, get, post, put } from "../../api/client.ts";
import { useJobs } from "../../components/JobsIndicator.tsx";
import { ModelNote } from "../../components/ModelNote.tsx";
import { estimateText, onSubscription, RunPanel } from "../../components/RunPanel.tsx";
import { displayTitle, plural } from "../../lib/format.ts";
import { ACTIVE_JOB } from "../../lib/stages.ts";
import { EntryDrawer } from "../kb/EntryDrawer.tsx";
import { useProject, useSourceName } from "../ProjectPage.tsx";
import { useSettings } from "../SettingsPage.tsx";
import { type CoinedTerm, CoinedTermDrawer } from "./CoinedTermDrawer.tsx";
import { TranslationModeChoice } from "./TranslationModeChoice.tsx";
import type { BookDetail, ChapterView, UnitView } from "./types.ts";
import { UnitRow, unitMark } from "./UnitRow.tsx";

interface Estimate {
  mode: "chunks" | "chapters";
  chunks: number;
  remaining: number;
  remainingChapters: number;
  sourceTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

type Filter = "all" | "attention" | "warnings" | "edited";

interface Totals {
  units: number;
  ok: number;
  flagged: number;
  refused: number;
  pending: number;
  edited: number;
}

function Spread({
  pid,
  bookId,
  chapter,
  targetName,
}: {
  pid: string;
  bookId: string;
  chapter: ChapterView;
  targetName: string;
}) {
  const source = useSourceName(pid);
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [showTags, setShowTags] = useState(false);
  const key = ["target", bookId, "units", chapter.id];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () =>
      get<{ units: UnitView[] }>(
        `/api/projects/${pid}/books/${bookId}/chapters/${chapter.id}/units`,
      ),
  });
  const all = data?.units ?? [];
  const counts = useMemo(
    () => ({
      attention: all.filter((u) => unitMark(u) === "attention").length,
      warnings: all.filter((u) => u.warnings.length > 0).length,
      edited: all.filter((u) => u.status === "edited").length,
    }),
    [all],
  );
  const units = useMemo(() => {
    if (filter === "attention") return all.filter((u) => unitMark(u) === "attention");
    if (filter === "warnings") return all.filter((u) => u.warnings.length > 0);
    if (filter === "edited") return all.filter((u) => u.status === "edited");
    return all;
  }, [all, filter]);

  const listRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    if (listRef.current) setOffset(listRef.current.getBoundingClientRect().top + window.scrollY);
  });
  const virtualizer = useWindowVirtualizer({
    count: units.length,
    // Measured heights belong to a passage, not to a position in the (filtered) list.
    getItemKey: (i) => units[i]?.key ?? i,
    estimateSize: () => 120,
    overscan: 8,
    scrollMargin: offset,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ["target", bookId, "chapters"] });
  };
  const chunkIndexes = [...new Set(all.map((u) => u.chunkIndex))];

  return (
    <Box>
      <Group justify="space-between" align="flex-end" mb="md" gap="sm">
        <Box style={{ minWidth: 0 }}>
          <Title order={3}>{displayTitle(chapter.title)}</Title>
          <Text size="sm" c="dimmed" mt={2}>
            {plural(chapter.units, "passage")}
            {chapter.pending > 0 ? `, ${chapter.pending} not translated yet` : ""}
          </Text>
        </Box>
        <Group gap="md">
          <Switch
            size="xs"
            label="Show tags"
            checked={showTags}
            onChange={(e) => setShowTags(e.currentTarget.checked)}
          />
          {chunkIndexes.length > 0 && (
            <Button
              size="xs"
              variant="default"
              onClick={async () => {
                if (
                  !window.confirm(
                    `Translate the whole chapter again (${plural(chunkIndexes.length, "part")})? Your own edits are kept.`,
                  )
                )
                  return;
                try {
                  for (const n of chunkIndexes)
                    await post(`/api/projects/${pid}/books/${bookId}/chunks/${n}/retranslate`, {
                      instruction: null,
                    });
                  notifications.show({ message: "Translating the chapter again." });
                } catch (e) {
                  notifications.show({
                    color: "red",
                    title: "Couldn't start",
                    message: (e as Error).message,
                  });
                }
              }}
            >
              Translate chapter again
            </Button>
          )}
        </Group>
      </Group>
      <SegmentedControl
        mb="md"
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        data={[
          { value: "all", label: `All ${all.length}` },
          { value: "attention", label: `Need attention ${counts.attention}` },
          { value: "warnings", label: `Warnings ${counts.warnings}` },
          { value: "edited", label: `Edited ${counts.edited}` },
        ]}
      />
      {isLoading && <Loader size="sm" />}
      {data && units.length === 0 && (
        <Text size="md" c="dimmed" py="xl">
          {filter === "all" ? "This chapter has no text." : "Nothing here in this chapter."}
        </Text>
      )}
      {units.length > 0 && (
        <div className="tr-spread">
          <div className="tr-spread-head">
            <div>{source}</div>
            <div />
            <div>{targetName}</div>
            <div />
          </div>
          <div
            key={filter}
            ref={listRef}
            style={{ height: virtualizer.getTotalSize(), position: "relative", marginTop: 20 }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const unit = units[item.index]!;
              return (
                <div
                  key={unit.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  <UnitRow
                    pid={pid}
                    bookId={bookId}
                    unit={unit}
                    showTags={showTags}
                    onChanged={refresh}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Box>
  );
}

function TocPanel({ pid, bookId }: { pid: string; bookId: string }) {
  const source = useSourceName(pid);
  const client = useQueryClient();
  const key = ["target", bookId, "toc"];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      get<{
        title: string;
        translatedTitle: string | null;
        items: {
          key: string;
          file: string;
          source: string;
          translation: string | null;
          origin: string | null;
        }[];
      }>(`/api/projects/${pid}/books/${bookId}/toc`),
  });
  const [title, setTitle] = useState<string>("");
  const [items, setItems] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) {
      setTitle(data.translatedTitle ?? "");
      setItems(Object.fromEntries(data.items.map((i) => [i.key, i.translation ?? ""])));
    }
  }, [data]);
  if (!data) return <Loader size="sm" />;
  return (
    <Stack maw={860}>
      <Text size="sm" c="dimmed">
        The book's title and the labels in its table of contents. Labels that match a chapter
        heading reuse the heading's translation.
      </Text>
      <TextInput
        label="Title"
        description={`Original: ${data.title}`}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        styles={{ input: { fontFamily: "var(--tr-serif)", fontSize: 16 } }}
      />
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w="45%">{source} label</Table.Th>
            <Table.Th>Translation</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.items.map((i) => (
            <Table.Tr key={i.key}>
              <Table.Td>
                <div className="tr-term">{i.source}</div>
              </Table.Td>
              <Table.Td>
                <TextInput
                  size="xs"
                  aria-label={`Translation of ${i.source}`}
                  value={items[i.key] ?? ""}
                  onChange={(e) => setItems({ ...items, [i.key]: e.currentTarget.value })}
                  styles={{ input: { fontFamily: "var(--tr-serif)", fontSize: 14 } }}
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group justify="flex-end">
        <Button
          onClick={async () => {
            try {
              const changed = Object.fromEntries(
                Object.entries(items).filter(
                  ([k, v]) => v && v !== (data.items.find((i) => i.key === k)?.translation ?? ""),
                ),
              );
              await put(`/api/projects/${pid}/books/${bookId}/toc`, {
                title: title || null,
                items: changed,
              });
              await client.invalidateQueries({ queryKey: key });
              notifications.show({ color: "green", message: "Title and contents saved." });
            } catch (e) {
              notifications.show({
                color: "red",
                title: "Couldn't save",
                message: (e as Error).message,
              });
            }
          }}
        >
          Save title and contents
        </Button>
      </Group>
    </Stack>
  );
}

/** A coined term as a new knowledge base entry, to check and complete before moving it. */
function coinedEntry(t: CoinedTerm): KbEntry {
  return {
    id: "new",
    kind: t.kind,
    source: t.source,
    aliases: [],
    target: t.target,
    targetSeen: [],
    treatment: null,
    attributes: [],
    note: t.note,
    examples: [],
    refs: [],
    status: "locked",
    question: null,
    origin: "user",
    updatedAt: new Date().toISOString(),
  };
}

function GlossaryPanel({ pid, bookId }: { pid: string; bookId: string }) {
  const source = useSourceName(pid);
  const client = useQueryClient();
  const project = useProject(pid).data?.project;
  const languages = {
    source: languageDisplayName(project?.sourceLang ?? "en"),
    target: project?.targetLangName || "Translation",
  };
  const jobs = useJobs();
  // Translation runs write the coined terms, so they're changed only between runs.
  const translating = (jobs.data?.jobs ?? []).some(
    (j) =>
      j.targetId === bookId &&
      (j.type === "phase3" || j.type === "retranslate") &&
      ACTIVE_JOB.includes(j.status),
  );
  const queryKey = ["target", bookId, "glossary"];
  const { data } = useQuery({
    queryKey,
    queryFn: () => get<{ terms: CoinedTerm[] }>(`/api/projects/${pid}/books/${bookId}/glossary`),
  });
  const [editing, setEditing] = useState<{ index: number; term: CoinedTerm } | null>(null);
  const [moving, setMoving] = useState<{ index: number; term: CoinedTerm } | null>(null);
  if (!data) return <Loader size="sm" />;

  const base = `/api/projects/${pid}/books/${bookId}/glossary`;
  const call = async (fn: () => Promise<{ terms: CoinedTerm[] }>, message: string) => {
    try {
      client.setQueryData(queryKey, await fn());
      void client.invalidateQueries({ queryKey: ["target", bookId, "kb"] });
      void client.invalidateQueries({ queryKey: ["target", bookId, "kb-preview"] });
      notifications.show({ color: "green", message });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
      throw e;
    }
  };
  const remove = (index: number, t: CoinedTerm) => {
    if (!window.confirm(`Delete "${t.source}" from the coined terms?`)) return;
    void call(
      () => del<{ terms: CoinedTerm[] }>(`${base}/${index}?source=${encodeURIComponent(t.source)}`),
      "Coined term deleted.",
    ).catch(() => undefined);
  };
  const moveNotice = (t: CoinedTerm) =>
    [
      t.inKb
        ? `The knowledge base already has "${t.source}" (${t.inKb.target ?? "undecided"}). Saving replaces that entry with this one.`
        : null,
      t.conflict ? `Translated two ways: later, ${t.conflict}. Settle it before saving.` : null,
    ]
      .filter(Boolean)
      .join(" ") || null;

  return (
    <Stack maw={1080}>
      <Text size="sm" c="dimmed">
        Names and terms the AI had to invent while translating, because no knowledge base had them.
        Later chunks reuse them. Edit a term to change how later chunks translate it (passages
        already translated keep the old wording; change those with search and replace in Review).
        Move the ones worth keeping to the book's knowledge base, and delete the ones you don't
        want.
      </Text>
      {translating && (
        <Alert color="gray">
          The book is being translated. Change coined terms after it finishes or is paused.
        </Alert>
      )}
      {data.terms.length === 0 ? (
        <Text size="md" c="dimmed">
          Nothing was coined: every name and term came from the knowledge bases.
        </Text>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{source}</Table.Th>
              <Table.Th>Translation</Table.Th>
              <Table.Th>Note</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.terms.map((t, index) => (
              <Table.Tr key={`${t.kind}:${t.source}`}>
                <Table.Td>
                  <div className="tr-term">{t.source}</div>
                  <Text size="xs" c="dimmed">
                    {t.kind.replace("_", " ")}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <div className="tr-term">{t.target}</div>
                  {t.inKb && (
                    <Text size="xs" c="dimmed">
                      In the knowledge base as {t.inKb.target ?? "undecided"}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {t.note}
                  </Text>
                  {t.conflict && (
                    <Text size="sm" c="yellow">
                      {t.conflict}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap" justify="flex-end">
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      disabled={translating}
                      onClick={() => setEditing({ index, term: t })}
                    >
                      Edit
                    </Button>
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      disabled={translating}
                      onClick={() => setMoving({ index, term: t })}
                    >
                      Move to knowledge base
                    </Button>
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      color="red"
                      disabled={translating}
                      onClick={() => remove(index, t)}
                    >
                      Delete
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <CoinedTermDrawer
        term={editing?.term ?? null}
        languages={languages}
        onClose={() => setEditing(null)}
        onSave={(fields) =>
          call(
            () =>
              put<{ terms: CoinedTerm[] }>(`${base}/${editing!.index}`, {
                source: editing!.term.source,
                term: fields,
              }),
            "Coined term saved.",
          )
        }
      />
      <EntryDrawer
        entry={moving ? coinedEntry(moving.term) : null}
        isNew
        title="Move to the knowledge base"
        notice={moving ? moveNotice(moving.term) : null}
        languages={languages}
        onClose={() => setMoving(null)}
        onSave={(e) =>
          call(() => {
            const { id: _id, updatedAt: _u, origin: _o, refs: _r, ...entry } = e;
            return post<{ terms: CoinedTerm[] }>(`${base}/${moving!.index}/move`, {
              source: moving!.term.source,
              entry,
            });
          }, "Moved to the knowledge base.")
        }
        onSaveUnlocked={async () => undefined}
        onUnlock={async () => undefined}
        onDelete={async () => undefined}
        onAsk={() => Promise.reject(new Error("Not available while moving a term."))}
      />
    </Stack>
  );
}

export function ChapterList({
  chapters,
  selected,
  onSelect,
}: {
  chapters: ChapterView[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="tr-chapters" aria-label="Chapters">
      {chapters.map((c) => {
        const attention = c.flagged + c.refused;
        return (
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
              {attention > 0 ? (
                <Text span size="xs" c="red">
                  {attention} need attention
                </Text>
              ) : c.pending > 0 ? (
                `${c.pending} of ${c.units} not translated`
              ) : (
                plural(c.units, "passage")
              )}
              {c.edited > 0 && (
                <Text span size="xs" c="blue">
                  , {c.edited} edited
                </Text>
              )}
            </div>
          </button>
        );
      })}
    </nav>
  );
}

export function TranslatePanel({ pid, detail }: { pid: string; detail: BookDetail }) {
  const client = useQueryClient();
  const bookId = detail.book.id;
  const [params, setParams] = useSearchParams();
  const project = useProject(pid);
  const chapters = useQuery({
    queryKey: ["target", bookId, "chapters"],
    queryFn: () =>
      get<{ chapters: ChapterView[]; totals: Totals | null }>(
        `/api/projects/${pid}/books/${bookId}/chapters`,
      ),
  });
  const estimate = useQuery({
    queryKey: ["target", bookId, "phase3-estimate"],
    queryFn: () => get<Estimate>(`/api/projects/${pid}/books/${bookId}/phase3/estimate`),
  });
  const settings = useSettings();
  const jobs = useJobs();
  const job = (jobs.data?.jobs ?? []).find(
    (j) => j.targetId === bookId && (j.type === "phase3" || j.type === "retranslate"),
  );
  const running = job !== undefined && ACTIVE_JOB.includes(job.status);
  const model = settings.data?.settings.models.find(
    (m) => m.id === settings.data?.settings.steps["phase3.translate"].modelId,
  );
  const list = chapters.data?.chapters ?? [];
  const totals = chapters.data?.totals;
  const view = params.get("view") ?? "review";
  // Open where the work is: a chapter that needs attention, else the first real chapter.
  const firstWithWork =
    list.find((c) => c.flagged + c.refused > 0) ??
    list.find((c) => c.units >= 20) ??
    list.find((c) => c.units > 0) ??
    null;
  const selectedId = params.get("chapter") ?? firstWithWork?.id ?? null;
  const chapter = list.find((c) => c.id === selectedId) ?? null;
  const targetName = project.data?.project.targetLangName ?? "Translation";

  useEffect(() => {
    if (job && !running) {
      void client.invalidateQueries({ queryKey: ["target", bookId] });
    }
  }, [job?.status, running, client, bookId, job]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: key === "view" });
  };

  const state = detail.book.phase3.state;
  const remaining = estimate.data?.remaining ?? 0;
  const attention = totals ? totals.flagged + totals.refused : 0;
  const summary = totals
    ? `${plural(totals.ok + totals.edited, "passage")} translated${totals.edited > 0 ? `, ${totals.edited} edited by you` : ""}. ${attention > 0 ? `${attention} need attention.` : "None need attention."}${totals.pending > 0 ? ` ${totals.pending} not translated yet.` : ""}`
    : undefined;

  return (
    <>
      <RunPanel
        state={state}
        finishedAt={detail.book.phase3.finishedAt}
        job={job}
        summary={summary}
        estimate={
          estimate.data && remaining > 0
            ? `${
                estimate.data.mode === "chapters"
                  ? plural(estimate.data.remainingChapters, "chapter")
                  : plural(remaining, "chunk")
              } to go. ${estimateText({
                input: estimate.data.inputTokens,
                cached: estimate.data.cachedTokens,
                output: estimate.data.outputTokens,
                pricing: model?.pricing,
                subscription: onSubscription(settings.data?.settings, model?.id),
              })}`
            : undefined
        }
        extra={
          state !== "none" &&
          !running && (
            <Button
              variant="default"
              onClick={async () => {
                const how =
                  detail.book.translationMode === "chapters" ? "whole chapters" : "chunks";
                if (
                  !window.confirm(
                    `Translate the whole book again, in ${how}, with the current model and settings? The current translation, with your edits, is saved to History first, so you can compare or restore it.`,
                  )
                )
                  return;
                try {
                  await post(`/api/projects/${pid}/books/${bookId}/phase3/redo`);
                  void client.invalidateQueries({ queryKey: ["jobs"] });
                } catch (e) {
                  notifications.show({
                    color: "red",
                    title: "Couldn't start the translation",
                    message: (e as Error).message,
                  });
                }
              }}
            >
              Translate the whole book again
            </Button>
          )
        }
        actionLabel={state === "none" ? "Translate the book" : "Translate the rest"}
        hideAction={state !== "none" && remaining === 0}
        onRun={async () => {
          try {
            await post(`/api/projects/${pid}/books/${bookId}/phase3/run`);
            void client.invalidateQueries({ queryKey: ["jobs"] });
          } catch (e) {
            notifications.show({
              color: "red",
              title: "Couldn't start the translation",
              message: (e as Error).message,
            });
          }
        }}
      >
        {state === "none" && detail.book.phase2.state === "none" && (
          <Text size="sm" c="yellow" mt="sm" pl={22}>
            Phase 2 hasn't read this book yet. You can translate anyway, but names and terms will be
            less consistent.
          </Text>
        )}
        <TranslationModeChoice
          pid={pid}
          bookId={bookId}
          mode={detail.book.translationMode}
          disabled={running}
        />
        <ModelNote steps={["phase3.translate"]} />
      </RunPanel>

      <Tabs value={view} onChange={(v) => v && setParam("view", v)} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="review">Chapters</Tabs.Tab>
          <Tabs.Tab value="toc">Title and contents</Tabs.Tab>
          <Tabs.Tab value="glossary">Coined terms</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="review">
          {chapters.isLoading && <Loader size="sm" />}
          {chapters.data && list.length === 0 && (
            <Alert color="gray" maw={620}>
              Nothing is translated yet. Start the translation above; chapters appear here as
              they're done.
            </Alert>
          )}
          {list.length > 0 && (
            <Box className="tr-review">
              <ChapterList
                chapters={list}
                selected={chapter?.id ?? null}
                onSelect={(id) => {
                  setParam("chapter", id);
                  window.scrollTo({ top: 0 });
                }}
              />
              {chapter ? (
                <Spread
                  key={chapter.id}
                  pid={pid}
                  bookId={bookId}
                  chapter={chapter}
                  targetName={targetName}
                />
              ) : (
                <Text c="dimmed">Choose a chapter.</Text>
              )}
            </Box>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="toc">
          <TocPanel pid={pid} bookId={bookId} />
        </Tabs.Panel>
        <Tabs.Panel value="glossary">
          <GlossaryPanel pid={pid} bookId={bookId} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
