import { Box, Drawer, Group, Loader, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { get } from "../../api/client.ts";
import type { Job } from "../../api/types.ts";
import { useJobActivity } from "../../components/JobDetails.tsx";
import { Section } from "../../components/PageHeader.tsx";
import { StageMark } from "../../components/StageMark.tsx";
import { displayTitle, plural } from "../../lib/format.ts";
import { ACTIVE_JOB } from "../../lib/stages.ts";
import { KIND_TEXT } from "../kb/KbEditor.tsx";
import { useSourceName } from "../ProjectPage.tsx";

/** What one chapter read found (the phase 1 read output, as saved). */
interface Finding {
  kind: string;
  source: string;
  target: string | null;
  targetSeen: string[];
  treatment: string | null;
  attributes: { key: string; value: string }[];
  note: string;
  sourceQuote: string;
  targetQuote: string | null;
}

interface StyleNote {
  rule: string;
  sourceQuote: string;
  targetQuote: string;
}

interface ChapterRow {
  position: number;
  unitId: string;
  source: string[];
  target: string[];
  read: boolean;
  findings: number;
  styleNotes: number;
}

function FindingsDrawer({
  pid,
  pairId,
  chapter,
  onClose,
}: {
  pid: string;
  pairId: string;
  chapter: ChapterRow | null;
  onClose: () => void;
}) {
  const source = useSourceName(pid);
  const { data, isLoading } = useQuery({
    queryKey: ["pair", pairId, "phase1-chapter", chapter?.position],
    queryFn: () =>
      get<{ findings: Finding[]; styleNotes: StyleNote[] }>(
        `/api/projects/${pid}/pairs/${pairId}/phase1/chapters/${chapter!.position}`,
      ),
    enabled: chapter !== null,
  });
  return (
    <Drawer
      opened={chapter !== null}
      onClose={onClose}
      position="right"
      size="xl"
      title={chapter ? chapter.source.map(displayTitle).join(" + ") : ""}
    >
      {chapter && (
        <Text size="sm" c="dimmed" mb="lg" className="serif">
          {chapter.target.map(displayTitle).join(" + ")}
        </Text>
      )}
      {isLoading && <Loader size="sm" />}
      {data && (
        <Stack gap="xl">
          <Box>
            <Text fw={600} mb="xs">
              {plural(data.findings.length, "finding")}
            </Text>
            {data.findings.length === 0 ? (
              <Text size="sm" c="dimmed">
                The AI noted nothing in this chapter.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={640}>
                <Table verticalSpacing={8}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th w="26%">{source}</Table.Th>
                      <Table.Th w="26%">Translation</Table.Th>
                      <Table.Th>Note and quotes</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {data.findings.map((f, i) => {
                      // Models sometimes repeat a form, or list the dictionary form itself.
                      const seen = [...new Set(f.targetSeen)].filter((t) => t !== f.target);
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: findings have no ids and the list doesn't change
                        <Table.Tr key={i}>
                          <Table.Td style={{ verticalAlign: "top" }}>
                            <div className="tr-term" style={{ fontWeight: 600 }}>
                              {f.source}
                            </div>
                            <Text size="xs" c="dimmed">
                              {KIND_TEXT[f.kind] ?? f.kind}
                            </Text>
                          </Table.Td>
                          <Table.Td style={{ verticalAlign: "top" }}>
                            <div className="tr-term">{f.target ?? "–"}</div>
                            {seen.length > 0 && (
                              <Text size="xs" c="dimmed" className="serif">
                                also {seen.join(", ")}
                              </Text>
                            )}
                            {f.treatment && f.treatment !== "translated" && (
                              <Text size="xs" c="dimmed" fs="italic">
                                {f.treatment}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td style={{ verticalAlign: "top" }}>
                            {f.attributes.length > 0 && (
                              <Text size="sm">
                                {f.attributes.map((a) => `${a.key}: ${a.value}`).join("; ")}
                              </Text>
                            )}
                            {f.note && (
                              <Text size="sm" c="dimmed">
                                {f.note}
                              </Text>
                            )}
                            <Text size="xs" c="dimmed" className="serif" mt={4}>
                              “{f.sourceQuote}”{f.targetQuote ? ` becomes “${f.targetQuote}”` : ""}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Box>
          {data.styleNotes.length > 0 && (
            <Box>
              <Text fw={600} mb="xs">
                {plural(data.styleNotes.length, "style note")}
              </Text>
              <Stack gap="sm">
                {data.styleNotes.map((n) => (
                  <Box key={`${n.rule}:${n.sourceQuote}`}>
                    <Text size="sm" className="serif">
                      {n.rule}
                    </Text>
                    <Text size="xs" c="dimmed" className="serif">
                      “{n.sourceQuote}” becomes “{n.targetQuote}”
                    </Text>
                  </Box>
                ))}
              </Stack>
            </Box>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

/** Every chapter pair: read or not, what it found; click one to see its findings. */
export function Phase1Chapters({
  pid,
  pairId,
  job,
}: {
  pid: string;
  pairId: string;
  job: Job | undefined;
}) {
  const source = useSourceName(pid);
  const running = job !== undefined && ACTIVE_JOB.includes(job.status);
  const chapters = useQuery({
    queryKey: ["pair", pairId, "phase1-chapters"],
    queryFn: () =>
      get<{ chapters: ChapterRow[] }>(`/api/projects/${pid}/pairs/${pairId}/phase1/chapters`),
    refetchInterval: running ? 5000 : false,
  });
  const activity = useJobActivity(running ? job : undefined);
  const [open, setOpen] = useState<ChapterRow | null>(null);
  // Requests are labelled "read a12" or "read a12 part 1/2".
  const readingNow = new Set(
    (activity.data?.active ?? [])
      .filter((a) => a.label.startsWith("read "))
      .map((a) => a.label.split(" ")[1]),
  );
  const list = chapters.data?.chapters ?? [];
  const read = list.filter((c) => c.read).length;
  const total = list.reduce((n, c) => n + c.findings, 0);

  return (
    <Section
      title="Chapter pairs"
      description={
        list.length > 0
          ? `${read} of ${list.length} read so far, with ${plural(total, "finding")}. Click a chapter to see what the AI noted in it.`
          : "The chapters phase 1 reads, from the alignment."
      }
    >
      {chapters.isLoading && <Loader size="sm" />}
      {list.length > 0 && (
        <Table.ScrollContainer minWidth={640}>
          <Table highlightOnHover verticalSpacing={8}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{source}</Table.Th>
                <Table.Th>Translation</Table.Th>
                <Table.Th w={150}>Status</Table.Th>
                <Table.Th w={110} ta="right">
                  Findings
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody className="num">
              {list.map((c) => {
                const now = readingNow.has(c.unitId);
                return (
                  <Table.Tr
                    key={c.position}
                    style={{ cursor: c.read ? "pointer" : undefined }}
                    tabIndex={c.read ? 0 : undefined}
                    onClick={() => c.read && setOpen(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && c.read) setOpen(c);
                    }}
                  >
                    <Table.Td>
                      <div className="tr-term">{c.source.map(displayTitle).join(" + ")}</div>
                    </Table.Td>
                    <Table.Td>
                      <div className="tr-term">{c.target.map(displayTitle).join(" + ")}</div>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <StageMark state={now ? "running" : c.read ? "done" : "none"} />
                        <Text size="sm" c={c.read || now ? undefined : "dimmed"}>
                          {now
                            ? c.read
                              ? "reading again"
                              : "reading now"
                            : c.read
                              ? "read"
                              : "not read yet"}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm">{c.read ? c.findings.toLocaleString() : "–"}</Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <FindingsDrawer pid={pid} pairId={pairId} chapter={open} onClose={() => setOpen(null)} />
    </Section>
  );
}
