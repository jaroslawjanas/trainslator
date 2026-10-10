import {
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  NavLink,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { JobRow, useJobs } from "../../components/JobsIndicator.tsx";
import { costText } from "../pair/Phase1Panel.tsx";
import { useSettings } from "../SettingsPage.tsx";
import type { BookDetail, ChapterView, UnitView } from "./types.ts";
import { UnitRow } from "./UnitRow.tsx";

interface Estimate {
  chunks: number;
  remaining: number;
  sourceTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

function UnitList({ pid, bookId, chapter }: { pid: string; bookId: string; chapter: ChapterView }) {
  const client = useQueryClient();
  const [filter, setFilter] = useState("all");
  const key = ["target", bookId, "units", chapter.id];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () =>
      get<{ units: UnitView[] }>(
        `/api/projects/${pid}/books/${bookId}/chapters/${chapter.id}/units`,
      ),
  });
  const units = useMemo(() => {
    const list = data?.units ?? [];
    if (filter === "problems")
      return list.filter((u) => u.status === "flagged" || u.status === "refused");
    if (filter === "warnings") return list.filter((u) => u.warnings.length > 0);
    if (filter === "edited") return list.filter((u) => u.status === "edited");
    return list;
  }, [data, filter]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: units.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 6,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ["target", bookId, "chapters"] });
  };
  const chunkIndexes = [...new Set((data?.units ?? []).map((u) => u.chunkIndex))];

  return (
    <Stack>
      <Group justify="space-between">
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={setFilter}
          data={[
            { value: "all", label: `All (${chapter.units})` },
            {
              value: "problems",
              label: `Flagged / refused (${chapter.flagged + chapter.refused})`,
            },
            { value: "warnings", label: "With warnings" },
            { value: "edited", label: `Edited (${chapter.edited})` },
          ]}
        />
        <Group gap="xs">
          {chunkIndexes.length > 0 && (
            <Button
              size="xs"
              variant="default"
              onClick={async () => {
                if (
                  !window.confirm(
                    `Re-translate all ${chunkIndexes.length} part(s) of this chapter? Your manual edits are kept.`,
                  )
                )
                  return;
                try {
                  for (const n of chunkIndexes)
                    await post(`/api/projects/${pid}/books/${bookId}/chunks/${n}/retranslate`, {
                      instruction: null,
                    });
                  notifications.show({ message: "Re-translation started." });
                } catch (e) {
                  notifications.show({
                    color: "red",
                    title: "Couldn't start",
                    message: (e as Error).message,
                  });
                }
              }}
            >
              Re-translate chapter
            </Button>
          )}
        </Group>
      </Group>
      {isLoading && <Loader />}
      <Grid>
        <Grid.Col span={6}>
          <Text size="xs" c="dimmed">
            English
          </Text>
        </Grid.Col>
        <Grid.Col span={6}>
          <Text size="xs" c="dimmed">
            Translation
          </Text>
        </Grid.Col>
      </Grid>
      <div ref={parentRef} style={{ height: "70vh", overflow: "auto" }}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
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
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <UnitRow pid={pid} bookId={bookId} unit={unit} onChanged={refresh} />
              </div>
            );
          })}
        </div>
      </div>
    </Stack>
  );
}

function TocPanel({ pid, bookId }: { pid: string; bookId: string }) {
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
  if (!data) return <Loader />;
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        The book's title and the labels of its table of contents. Labels that match a chapter
        heading reuse the heading's translation.
      </Text>
      <TextInput
        label={`Title (original: ${data.title})`}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />
      <Paper withBorder>
        <ScrollArea h={420}>
          <Table>
            <Table.Tbody>
              {data.items.map((i) => (
                <Table.Tr key={i.key}>
                  <Table.Td w="45%">
                    <Text size="sm">{i.source}</Text>
                    <Text size="xs" c="dimmed">
                      {i.file.split("/").pop()} {i.origin ? `· ${i.origin}` : ""}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      value={items[i.key] ?? ""}
                      onChange={(e) => setItems({ ...items, [i.key]: e.currentTarget.value })}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Paper>
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
              notifications.show({ color: "green", message: "Saved." });
            } catch (e) {
              notifications.show({
                color: "red",
                title: "Couldn't save",
                message: (e as Error).message,
              });
            }
          }}
        >
          Save title and labels
        </Button>
      </Group>
    </Stack>
  );
}

function GlossaryPanel({ pid, bookId }: { pid: string; bookId: string }) {
  const { data } = useQuery({
    queryKey: ["target", bookId, "glossary"],
    queryFn: () =>
      get<{
        terms: {
          kind: string;
          source: string;
          target: string;
          note: string;
          conflict: string | null;
        }[];
      }>(`/api/projects/${pid}/books/${bookId}/glossary`),
  });
  if (!data) return <Loader />;
  if (data.terms.length === 0)
    return (
      <Text size="sm" c="dimmed">
        No terms were coined during translation.
      </Text>
    );
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Names and terms the AI had to invent while translating (not in the knowledge bases). Later
        chunks reuse them. Add important ones to the book's knowledge base to fix them for good.
      </Text>
      <Table striped>
        <Table.Tbody>
          {data.terms.map((t) => (
            <Table.Tr key={`${t.kind}:${t.source}`}>
              <Table.Td>{t.source}</Table.Td>
              <Table.Td>{t.target}</Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {t.note}
                </Text>
                {t.conflict && (
                  <Text size="xs" c="orange">
                    {t.conflict}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

export function TranslatePanel({ pid, detail }: { pid: string; detail: BookDetail }) {
  const client = useQueryClient();
  const bookId = detail.book.id;
  const chapters = useQuery({
    queryKey: ["target", bookId, "chapters"],
    queryFn: () =>
      get<{ chapters: ChapterView[]; totals: Record<string, number> | null }>(
        `/api/projects/${pid}/books/${bookId}/chapters`,
      ),
  });
  const estimate = useQuery({
    queryKey: ["target", bookId, "phase3-estimate"],
    queryFn: () => get<Estimate>(`/api/projects/${pid}/books/${bookId}/phase3/estimate`),
  });
  const settings = useSettings();
  const jobs = useJobs();
  const [selected, setSelected] = useState<string | null>(null);
  const job = (jobs.data?.jobs ?? []).find(
    (j) => j.targetId === bookId && (j.type === "phase3" || j.type === "retranslate"),
  );
  const running = job && ["queued", "running", "pausing"].includes(job.status);
  const model = settings.data?.settings.models.find(
    (m) => m.id === settings.data?.settings.steps["phase3.translate"].modelId,
  );
  const list = chapters.data?.chapters ?? [];
  const chapter = list.find((c) => c.id === selected) ?? null;
  const totals = chapters.data?.totals;

  useEffect(() => {
    if (job && !running) {
      void client.invalidateQueries({ queryKey: ["target", bookId] });
    }
  }, [job?.status, running, client, bookId, job]);

  return (
    <Stack>
      {estimate.data && (
        <Card withBorder>
          <Text size="sm">
            {estimate.data.chunks} chunks ({estimate.data.remaining} left) · about{" "}
            {estimate.data.inputTokens.toLocaleString()} input tokens (
            {estimate.data.cachedTokens.toLocaleString()} cacheable) and{" "}
            {estimate.data.outputTokens.toLocaleString()} output tokens left ·{" "}
            {costText(
              estimate.data.inputTokens - estimate.data.cachedTokens,
              estimate.data.outputTokens,
              model?.pricing,
            )}
          </Text>
        </Card>
      )}
      {detail.book.phase2.state === "none" && (
        <Alert color="blue">
          Phase 2 hasn't been run for this book. You can translate anyway, but names and terms will
          be less consistent.
        </Alert>
      )}
      {job && <JobRow job={job} />}
      <Group>
        <Button
          disabled={Boolean(running)}
          onClick={async () => {
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
          {detail.book.phase3.state === "none" ? "Translate the book" : "Continue translating"}
        </Button>
        {totals && (
          <Text size="sm">
            {totals.ok} ok · {totals.edited} edited · {totals.flagged} flagged · {totals.refused}{" "}
            refused · {totals.pending} not yet translated
          </Text>
        )}
      </Group>
      <Tabs defaultValue="review" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="review">Review</Tabs.Tab>
          <Tabs.Tab value="toc">Title &amp; contents</Tabs.Tab>
          <Tabs.Tab value="glossary">Coined terms</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="review" pt="md">
          {list.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing translated yet.
            </Text>
          ) : (
            <Grid>
              <Grid.Col span={{ base: 12, md: 3 }}>
                <ScrollArea h="75vh">
                  {list.map((c) => (
                    <NavLink
                      key={c.id}
                      active={c.id === selected}
                      onClick={() => setSelected(c.id)}
                      label={c.title}
                      description={`${c.ok + c.edited}/${c.units} done`}
                      rightSection={
                        c.flagged + c.refused > 0 ? (
                          <Badge size="xs" color="red" variant="light">
                            {c.flagged + c.refused}
                          </Badge>
                        ) : c.pending > 0 ? (
                          <Badge size="xs" color="gray" variant="light">
                            {c.pending}
                          </Badge>
                        ) : null
                      }
                    />
                  ))}
                </ScrollArea>
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 9 }}>
                {chapter ? (
                  <UnitList key={chapter.id} pid={pid} bookId={bookId} chapter={chapter} />
                ) : (
                  <Text size="sm" c="dimmed">
                    Choose a chapter to review it.
                  </Text>
                )}
              </Grid.Col>
            </Grid>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="toc" pt="md">
          <TocPanel pid={pid} bookId={bookId} />
        </Tabs.Panel>
        <Tabs.Panel value="glossary" pt="md">
          <GlossaryPanel pid={pid} bookId={bookId} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
