import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Checkbox,
  Group,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { BookSetup } from "../../../../src/shared/schemas/epub.ts";
import { del, patch, put } from "../../api/client.ts";
import { DiagnosticsList } from "../../components/DiagnosticsList.tsx";
import { Section } from "../../components/PageHeader.tsx";
import { displayTitle, plural } from "../../lib/format.ts";
import type { BookDetail } from "./types.ts";

const GUESS_TEXT: Record<string, string> = {
  front: "front matter",
  back: "back matter",
  body: "",
};

export function SetupPanel({ pid, detail }: { pid: string; detail: BookDetail }) {
  const client = useQueryClient();
  const navigate = useNavigate();
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
      await client.invalidateQueries({ queryKey: ["project", pid] });
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
  const pairTitle = (id: string) =>
    displayTitle(detail.pairs.find((p) => p.id === id)?.title ?? id);
  const unused = detail.pairs.filter((p) => !pairIds.includes(p.id));
  const chosenWords = segments
    .filter((s) => setup.phase2Segments.includes(s.id))
    .reduce((n, s) => n + s.words, 0);

  return (
    <Box maw={980}>
      <Text size="md" c="dimmed" mb="xl">
        {displayTitle(book.title)}: {plural(structure.totalWords, "word")} in{" "}
        {plural(structure.docs.length, "file")}, EPUB {structure.version}, from{" "}
        <span className="mono">{book.sourceFileName}</span>.
      </Text>

      <Section
        title="Reference knowledge"
        description="The knowledge bases of these reference pairs go into phases 2 and 3, in this order."
      >
        {detail.pairs.length === 0 ? (
          <Text size="md" c="dimmed">
            This project has no reference pairs, so the book is translated with its own knowledge
            base only.
          </Text>
        ) : (
          <Stack gap={6}>
            {pairIds.map((id, i) => (
              <Group key={id} gap="xs" wrap="nowrap">
                <Checkbox
                  checked
                  aria-label={`Use ${pairTitle(id)}`}
                  onChange={() => setPairIds(pairIds.filter((x) => x !== id))}
                />
                <Text size="md" className="serif" style={{ flex: 1 }}>
                  {pairTitle(id)}
                </Text>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label="Move up"
                >
                  <IconArrowUp size={14} />
                </ActionIcon>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  disabled={i === pairIds.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  <IconArrowDown size={14} />
                </ActionIcon>
              </Group>
            ))}
            {unused.map((p) => (
              <Group key={p.id} gap="xs">
                <Checkbox
                  checked={false}
                  aria-label={`Use ${displayTitle(p.title)}`}
                  onChange={() => setPairIds([...pairIds, p.id])}
                />
                <Text size="md" c="dimmed" className="serif">
                  {displayTitle(p.title)}
                  {p.phase1.state === "none" ? " (not learned yet)" : ""}
                </Text>
              </Group>
            ))}
            {dirtyPairs && (
              <Group mt="xs">
                <Button size="xs" onClick={() => saveBook({ pairIds })}>
                  Save the choice of pairs
                </Button>
                <Button size="xs" variant="default" onClick={() => setPairIds(book.pairIds)}>
                  Undo
                </Button>
              </Group>
            )}
            <Group align="center" mt="md" gap="md">
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
                Now using {detail.reference.mode === "all" ? "all" : "the relevant"}{" "}
                {detail.reference.entries} of {detail.reference.totalEntries} entries, about{" "}
                {detail.reference.tokens.toLocaleString()} tokens per request.
              </Text>
            </Group>
          </Stack>
        )}
      </Section>

      <Section
        title="Chapters for phase 2"
        description={`Phase 2 reads the ticked chapters in order (${plural(chosenWords, "word")} now). Front and back matter are rarely worth reading.`}
        actions={
          <Select
            aria-label="Chapters from the table of contents"
            w={230}
            data={Array.from({ length: Math.max(1, structure.maxDepth) }, (_, i) => ({
              value: String(i + 1),
              label: i === 0 ? "Top-level chapters" : `Chapters down to level ${i + 1}`,
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
        }
      >
        <ScrollArea.Autosize mah={420}>
          <Table>
            <Table.Tbody>
              {segments.map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td w={36}>
                    <Checkbox
                      aria-label={`Read ${displayTitle(s.title)}`}
                      checked={setup.phase2Segments.includes(s.id)}
                      onChange={(e) =>
                        setSetup({
                          ...setup,
                          phase2Segments: e.currentTarget.checked
                            ? segments
                                .filter((x) => x.id === s.id || setup.phase2Segments.includes(x.id))
                                .map((x) => x.id)
                            : setup.phase2Segments.filter((x) => x !== s.id),
                        })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <div className="tr-term">{displayTitle(s.title)}</div>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {s.preview.start}
                    </Text>
                  </Table.Td>
                  <Table.Td w={120} ta="right" className="num">
                    <Text size="sm">{s.words.toLocaleString()}</Text>
                    <Text size="xs" c="dimmed">
                      {s.linear ? GUESS_TEXT[s.guess] || "words" : "outside reading order"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Section>

      <Section
        title="Files to translate"
        description="Every file is translated unless you keep it in the original, for example an index or an appendix that stays in the original language."
      >
        <ScrollArea.Autosize mah={360}>
          <Table>
            <Table.Tbody>
              {structure.docs.map((d) => {
                const notes = [
                  plural(d.words, "word"),
                  d.inSpine ? null : "not in the reading order",
                  d.isNav ? "navigation" : null,
                  d.unsafeUnits > 0
                    ? `${plural(d.unsafeUnits, "paragraph")} with broken markup stay untranslated`
                    : null,
                ].filter(Boolean);
                return (
                  <Table.Tr key={d.index}>
                    <Table.Td>
                      <Text size="sm" className="mono">
                        {d.href.split("/").pop()}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {notes.join(", ")}
                      </Text>
                    </Table.Td>
                    <Table.Td w={170}>
                      <Switch
                        size="xs"
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
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Section>

      {dirtySetup && (
        <Alert color="bookcloth" variant="light" mb="xl">
          <Group justify="space-between">
            <Text size="sm">You changed the chapters or files.</Text>
            <Group gap="xs">
              <Button size="xs" variant="default" onClick={() => setSetup(detail.setup)}>
                Undo
              </Button>
              <Button size="xs" onClick={saveSetup}>
                Save setup
              </Button>
            </Group>
          </Group>
        </Alert>
      )}

      <Section title="Output">
        <Stack>
          <Switch
            label="Give the translation a new book identifier"
            description="Recommended: reading apps then treat it as a different book from the original."
            checked={book.options.newIdentifier}
            onChange={(e) => saveBook({ options: { newIdentifier: e.currentTarget.checked } })}
          />
          <Switch
            label="Remove embedded fonts"
            description="Use this when the build reports characters the book's fonts can't show."
            checked={book.options.removeEmbeddedFonts}
            onChange={(e) =>
              saveBook({ options: { removeEmbeddedFonts: e.currentTarget.checked } })
            }
          />
        </Stack>
      </Section>

      {structure.diagnostics.length > 0 && (
        <Section title="Notes about the files">
          <DiagnosticsList diagnostics={structure.diagnostics} />
        </Section>
      )}

      <Section
        title="Delete this book"
        description="Deletes the book with its knowledge base, translation and builds. Reference pairs are kept."
      >
        <Button
          color="red"
          variant="outline"
          onClick={async () => {
            if (!window.confirm("Delete this book with its knowledge base and translation?"))
              return;
            try {
              await del(`/api/projects/${pid}/books/${book.id}`);
              await client.invalidateQueries({ queryKey: ["project", pid] });
              navigate(`/projects/${pid}`);
            } catch (e) {
              notifications.show({
                color: "red",
                title: "Couldn't delete",
                message: (e as Error).message,
              });
            }
          }}
        >
          Delete book
        </Button>
      </Section>
    </Box>
  );
}
