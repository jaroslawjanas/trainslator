import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  MultiSelect,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  KB_KINDS,
  type Kb,
  type KbEntry,
  type KbOverrides,
  type StyleRule,
} from "../../../../src/shared/schemas/kb.ts";
import { del, get, post, put } from "../../api/client.ts";
import { EntryDrawer } from "./EntryDrawer.tsx";

const STATUS_COLOR = { locked: "grape", open: "orange", auto: "gray" } as const;

function newEntry(): KbEntry {
  return {
    id: "new",
    kind: "person",
    source: "",
    aliases: [],
    target: null,
    targetSeen: [],
    treatment: null,
    attributes: [],
    note: "",
    examples: [],
    refs: [],
    status: "locked",
    question: null,
    origin: "user",
    updatedAt: new Date().toISOString(),
  };
}

function StyleRules({
  rules,
  base,
  onChange,
}: {
  rules: StyleRule[];
  base: string;
  onChange: (kb: Kb) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState("");
  const call = async (fn: () => Promise<{ kb: Kb }>) => {
    try {
      onChange((await fn()).kb);
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    }
  };
  return (
    <Stack>
      {rules.length === 0 && (
        <Text size="sm" c="dimmed">
          No style rules yet.
        </Text>
      )}
      {rules.map((r, i) => (
        <Group key={r.id} align="flex-start" wrap="nowrap">
          <Text size="sm" w={24} c="dimmed">
            {i + 1}.
          </Text>
          {editing === r.id ? (
            <Stack style={{ flex: 1 }} gap="xs">
              <Textarea autosize value={text} onChange={(e) => setText(e.currentTarget.value)} />
              <Group gap="xs">
                <Button
                  size="xs"
                  onClick={() =>
                    call(async () => {
                      const res = await put<{ kb: Kb }>(`${base}/style-rules/${r.id}`, {
                        ...r,
                        rule: text,
                      });
                      setEditing(null);
                      return res;
                    })
                  }
                >
                  Save
                </Button>
                <Button size="xs" variant="default" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          ) : (
            <Stack gap={2} style={{ flex: 1 }}>
              <Text size="sm">
                {r.rule}{" "}
                {r.status === "locked" && (
                  <Badge size="xs" color="grape" variant="light">
                    locked
                  </Badge>
                )}
              </Text>
              {r.examples.slice(0, 1).map((x) => (
                <Text key={x.source} size="xs" c="dimmed">
                  “{x.source}”{x.target ? ` → “${x.target}”` : ""}
                </Text>
              ))}
            </Stack>
          )}
          {editing !== r.id && (
            <Group gap={4} wrap="nowrap">
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => {
                  setEditing(r.id);
                  setText(r.rule);
                }}
              >
                Edit
              </Button>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                aria-label="Delete rule"
                onClick={() => call(() => del<{ kb: Kb }>(`${base}/style-rules/${r.id}`))}
              >
                ×
              </ActionIcon>
            </Group>
          )}
        </Group>
      ))}
      <Group align="flex-end">
        <TextInput
          style={{ flex: 1 }}
          label="Add a rule"
          placeholder="e.g. Keep imperial units; don't convert to metric."
          value={adding}
          onChange={(e) => setAdding(e.currentTarget.value)}
        />
        <Button
          disabled={!adding.trim()}
          onClick={() =>
            call(async () => {
              const res = await post<{ kb: Kb }>(`${base}/style-rules`, { rule: adding });
              setAdding("");
              return res;
            })
          }
        >
          Add
        </Button>
      </Group>
    </Stack>
  );
}

export function KbEditor({
  pid,
  scope,
  targetId,
}: {
  pid: string;
  scope: "pair" | "book";
  targetId: string;
}) {
  const client = useQueryClient();
  const base = `/api/projects/${pid}/${scope === "pair" ? "pairs" : "books"}/${targetId}/kb`;
  const queryKey = ["target", targetId, "kb"];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => get<{ kb: Kb; overrides: KbOverrides }>(base),
  });
  const preview = useQuery({
    queryKey: ["target", targetId, "kb-preview"],
    queryFn: () => get<{ text: string; tokens: number }>(`${base}/preview`),
  });
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<{ entry: KbEntry; isNew: boolean } | null>(null);

  const entries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.kb.entries ?? [])
      .filter(
        (e) =>
          (kinds.length === 0 || kinds.includes(e.kind)) &&
          (status === "all" || e.status === status),
      )
      .filter(
        (e) =>
          !q ||
          [e.source, e.target ?? "", e.note, ...e.aliases].some((s) => s.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          (a.status === "open" ? -1 : 0) - (b.status === "open" ? -1 : 0) ||
          a.source.localeCompare(b.source),
      );
  }, [data, search, kinds, status]);

  if (isLoading) return <Loader />;
  if (error || !data) return <Alert color="red">{(error as Error)?.message}</Alert>;

  const update = (kb: Kb) => {
    client.setQueryData(queryKey, { ...data, kb });
    void client.invalidateQueries({ queryKey: ["target", targetId, "kb-preview"] });
  };
  const call = async (fn: () => Promise<{ kb: Kb }>, message: string) => {
    try {
      update((await fn()).kb);
      notifications.show({ color: "green", message });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
      throw e;
    }
  };
  const open = data.kb.entries.filter((e) => e.status === "open").length;

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {data.kb.entries.length} entries · {data.kb.styleRules.length} style rules ·{" "}
          {Object.keys(data.overrides.entries).length} edited by you
          {open > 0 ? ` · ${open} open question${open === 1 ? "" : "s"}` : ""}
        </Text>
        <Button size="xs" onClick={() => setEditing({ entry: newEntry(), isNew: true })}>
          Add entry
        </Button>
      </Group>
      <Tabs defaultValue="entries" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="entries">Entries</Tabs.Tab>
          <Tabs.Tab value="style">Style rules</Tabs.Tab>
          <Tabs.Tab value="preview">As the AI sees it</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="entries" pt="md">
          <Stack>
            <Group align="flex-end">
              <TextInput
                label="Search"
                placeholder="Name, translation, note …"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <MultiSelect
                label="Kinds"
                data={[...KB_KINDS]}
                value={kinds}
                onChange={setKinds}
                clearable
                w={260}
              />
              <SegmentedControl
                value={status}
                onChange={setStatus}
                data={[
                  { value: "all", label: "All" },
                  { value: "open", label: "Open" },
                  { value: "locked", label: "Locked" },
                  { value: "auto", label: "Automatic" },
                ]}
              />
            </Group>
            {entries.length === 0 ? (
              <Text size="sm" c="dimmed">
                {data.kb.entries.length === 0
                  ? "The knowledge base is empty. Run the phase to fill it."
                  : "No entries match the filters."}
              </Text>
            ) : (
              <ScrollArea>
                <Table highlightOnHover striped verticalSpacing={6}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>English</Table.Th>
                      <Table.Th>Translation</Table.Th>
                      <Table.Th>Kind</Table.Th>
                      <Table.Th>Facts</Table.Th>
                      <Table.Th>Note</Table.Th>
                      <Table.Th>Status</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {entries.map((e) => (
                      <Table.Tr
                        key={e.id}
                        style={{ cursor: "pointer" }}
                        onClick={() => setEditing({ entry: e, isNew: false })}
                      >
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {e.source}
                          </Text>
                          {e.aliases.length > 0 && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              also {e.aliases.join(", ")}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{e.target ?? "–"}</Text>
                          {e.treatment && e.treatment !== "translated" && (
                            <Text size="xs" c="dimmed">
                              {e.treatment}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Badge size="xs" variant="outline" color="gray">
                            {e.kind.replace("_", " ")}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">
                            {e.attributes.map((a) => `${a.key}: ${a.value}`).join("; ")}
                          </Text>
                        </Table.Td>
                        <Table.Td maw={320}>
                          <Text size="xs" lineClamp={2}>
                            {e.status === "open" && e.question ? `? ${e.question}` : e.note}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge size="sm" variant="light" color={STATUS_COLOR[e.status]}>
                            {e.status}
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="style" pt="md">
          <StyleRules rules={data.kb.styleRules} base={base} onChange={update} />
        </Tabs.Panel>
        <Tabs.Panel value="preview" pt="md">
          <Stack>
            <Text size="sm" c="dimmed">
              Exactly what goes into the prompts
              {preview.data ? ` (about ${preview.data.tokens.toLocaleString()} tokens)` : ""}.
            </Text>
            <Code block>{preview.data?.text || "(empty)"}</Code>
          </Stack>
        </Tabs.Panel>
      </Tabs>
      <EntryDrawer
        entry={editing?.entry ?? null}
        isNew={editing?.isNew ?? false}
        onClose={() => setEditing(null)}
        onSave={(e) =>
          editing?.isNew
            ? call(() => {
                const { id: _id, updatedAt: _u, origin: _o, refs: _r, ...draft } = e;
                return post<{ kb: Kb }>(`${base}/entries`, draft);
              }, "Entry added.")
            : call(() => put<{ kb: Kb }>(`${base}/entries/${e.id}`, e), "Entry saved and locked.")
        }
        onUnlock={(e) =>
          call(() => post<{ kb: Kb }>(`${base}/entries/${e.id}/unlock`), "Entry unlocked.")
        }
        onDelete={(e) => call(() => del<{ kb: Kb }>(`${base}/entries/${e.id}`), "Entry deleted.")}
      />
    </Stack>
  );
}
