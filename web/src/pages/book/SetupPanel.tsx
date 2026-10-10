import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { BookSetup } from "../../../../src/shared/schemas/epub.ts";
import { patch, put } from "../../api/client.ts";
import type { BookDetail } from "./types.ts";

export function SetupPanel({ pid, detail }: { pid: string; detail: BookDetail }) {
  const client = useQueryClient();
  const { book, structure } = detail;
  const [setup, setSetup] = useState<BookSetup>(detail.setup);
  const [pairIds, setPairIds] = useState(book.pairIds);
  useEffect(() => setSetup(detail.setup), [detail.setup]);
  useEffect(() => setPairIds(book.pairIds), [book.pairIds]);
  const segments = structure.segmentsByDepth[String(setup.tocDepth)] ?? [];
  const dirtySetup = JSON.stringify(setup) !== JSON.stringify(detail.setup);
  const dirtyPairs = JSON.stringify(pairIds) !== JSON.stringify(book.pairIds);
  const refresh = () => client.invalidateQueries({ queryKey: ["book", book.id] });

  const saveBook = async (body: Record<string, unknown>) => {
    try {
      await patch(`/api/projects/${pid}/books/${book.id}`, body);
      await refresh();
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    }
  };
  const saveSetup = async () => {
    try {
      await put(`/api/projects/${pid}/books/${book.id}/setup`, setup);
      await refresh();
      notifications.show({ color: "green", message: "Setup saved." });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    }
  };
  const move = (i: number, d: number) => {
    const next = [...pairIds];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    setPairIds(next);
  };
  const pairTitle = (id: string) => detail.pairs.find((p) => p.id === id)?.title ?? id;
  const unused = detail.pairs.filter((p) => !pairIds.includes(p.id));

  return (
    <Stack gap="xl">
      <Stack>
        <Title order={4}>Reference knowledge</Title>
        <Text size="sm" c="dimmed">
          Knowledge bases from these reference pairs are given to phases 2 and 3, in this order.
        </Text>
        {detail.pairs.length === 0 && (
          <Alert color="blue">
            This project has no reference pairs; the book will be translated with its own knowledge
            base only.
          </Alert>
        )}
        <Stack gap={4}>
          {pairIds.map((id, i) => (
            <Group key={id} gap="xs">
              <Checkbox checked onChange={() => setPairIds(pairIds.filter((x) => x !== id))} />
              <Text size="sm" style={{ flex: 1 }}>
                {pairTitle(id)}
              </Text>
              <ActionIcon
                size="sm"
                variant="subtle"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                aria-label="Move up"
              >
                ↑
              </ActionIcon>
              <ActionIcon
                size="sm"
                variant="subtle"
                disabled={i === pairIds.length - 1}
                onClick={() => move(i, 1)}
                aria-label="Move down"
              >
                ↓
              </ActionIcon>
            </Group>
          ))}
          {unused.map((p) => (
            <Group key={p.id} gap="xs">
              <Checkbox checked={false} onChange={() => setPairIds([...pairIds, p.id])} />
              <Text size="sm" c="dimmed">
                {p.title} {p.phase1.state === "none" ? "(phase 1 not run yet)" : ""}
              </Text>
            </Group>
          ))}
        </Stack>
        {dirtyPairs && (
          <Group>
            <Button size="xs" onClick={() => saveBook({ pairIds })}>
              Save pairs
            </Button>
          </Group>
        )}
        <Group align="center">
          <SegmentedControl
            value={book.refKbMode}
            onChange={(v) => saveBook({ refKbMode: v })}
            data={[
              { value: "auto", label: "Automatic" },
              { value: "all", label: "All entries" },
              { value: "relevant", label: "Only entries in this book" },
            ]}
          />
          <Text size="sm" c="dimmed">
            Using {detail.reference.mode === "all" ? "all" : "only relevant"} entries:{" "}
            {detail.reference.entries} of {detail.reference.totalEntries}, about{" "}
            {detail.reference.tokens.toLocaleString()} tokens per request.
          </Text>
        </Group>
      </Stack>

      <Stack>
        <Group justify="space-between">
          <Title order={4}>Chapters for phase 2</Title>
          <Select
            label="Chapters from TOC"
            w={220}
            data={Array.from({ length: Math.max(1, structure.maxDepth) }, (_, i) => ({
              value: String(i + 1),
              label: i === 0 ? "Top level" : `Down to level ${i + 1}`,
            }))}
            value={String(setup.tocDepth)}
            allowDeselect={false}
            onChange={(v) => {
              if (!v) return;
              const depth = Number(v);
              const segs = structure.segmentsByDepth[v] ?? [];
              setSetup({
                ...setup,
                tocDepth: depth,
                phase2Segments: segs
                  .filter((s) => s.linear && s.guess === "body" && s.words >= 100)
                  .map((s) => s.id),
              });
            }}
          />
        </Group>
        <Text size="sm" c="dimmed">
          Phase 2 reads the ticked chapters in order. Front and back matter are usually not worth
          reading.
        </Text>
        <Paper withBorder>
          <ScrollArea h={320}>
            <Table striped>
              <Table.Tbody>
                {segments.map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td w={40}>
                      <Checkbox
                        checked={setup.phase2Segments.includes(s.id)}
                        onChange={(e) =>
                          setSetup({
                            ...setup,
                            phase2Segments: e.currentTarget.checked
                              ? segments
                                  .filter(
                                    (x) => x.id === s.id || setup.phase2Segments.includes(x.id),
                                  )
                                  .map((x) => x.id)
                              : setup.phase2Segments.filter((x) => x !== s.id),
                          })
                        }
                      />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{s.title}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {s.preview.start}
                      </Text>
                    </Table.Td>
                    <Table.Td w={110}>
                      <Text size="sm">{s.words.toLocaleString()} words</Text>
                    </Table.Td>
                    <Table.Td w={80}>
                      <Badge size="xs" variant="light" color={s.guess === "body" ? "blue" : "gray"}>
                        {s.linear ? s.guess : "extra"}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      </Stack>

      <Stack>
        <Title order={4}>Files</Title>
        <Text size="sm" c="dimmed">
          Every file is translated unless you keep it in the original (for example an index or an
          English-only appendix).
        </Text>
        <Paper withBorder>
          <ScrollArea h={260}>
            <Table striped>
              <Table.Tbody>
                {structure.docs.map((d) => (
                  <Table.Tr key={d.index}>
                    <Table.Td>
                      <Text size="sm" className="mono">
                        {d.href.split("/").pop()}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {d.words.toLocaleString()} words
                        {d.inSpine ? "" : " · not in the reading order"}
                        {d.isNav ? " · navigation" : ""}
                        {d.unsafeUnits > 0
                          ? ` · ${d.unsafeUnits} paragraph(s) with broken markup stay untranslated`
                          : ""}
                      </Text>
                    </Table.Td>
                    <Table.Td w={200}>
                      <Switch
                        label="Keep original"
                        checked={setup.keepDocs.includes(d.index)}
                        onChange={(e) =>
                          setSetup({
                            ...setup,
                            keepDocs: e.currentTarget.checked
                              ? [...setup.keepDocs, d.index]
                              : setup.keepDocs.filter((x) => x !== d.index),
                          })
                        }
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      </Stack>

      <Group justify="flex-end">
        <Button variant="default" disabled={!dirtySetup} onClick={() => setSetup(detail.setup)}>
          Undo
        </Button>
        <Button disabled={!dirtySetup} onClick={saveSetup}>
          Save setup
        </Button>
      </Group>

      <Stack>
        <Title order={4}>Output</Title>
        <Switch
          label="Give the translation a new book identifier"
          description="Recommended: reading apps then treat it as a different book from the original."
          checked={book.options.newIdentifier}
          onChange={(e) => saveBook({ options: { newIdentifier: e.currentTarget.checked } })}
        />
        <Switch
          label="Remove embedded fonts"
          description="Use when the build reports characters the book's fonts can't show."
          checked={book.options.removeEmbeddedFonts}
          onChange={(e) => saveBook({ options: { removeEmbeddedFonts: e.currentTarget.checked } })}
        />
      </Stack>
    </Stack>
  );
}
