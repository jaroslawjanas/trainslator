import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Code,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconLock, IconQuestionMark, IconSearch, IconX } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { languageDisplayName } from "../../../../src/shared/languages.ts";
import {
  KB_KINDS,
  type Kb,
  type KbEntry,
  type KbOverrides,
  type StyleRule,
} from "../../../../src/shared/schemas/kb.ts";
import { del, get, post, put } from "../../api/client.ts";
import { count, plural } from "../../lib/format.ts";
import { useProject } from "../ProjectPage.tsx";
import { EntryDrawer, type KbAnswer } from "./EntryDrawer.tsx";

export const KIND_TEXT: Record<string, string> = {
  person: "person",
  place: "place",
  organization: "organization",
  named_thing: "named thing",
  term: "term",
  phrase: "phrase",
  wordplay: "wordplay",
  other: "other",
};

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

function StatusIcon({ status }: { status: KbEntry["status"] }) {
  if (status === "locked")
    return (
      <Tooltip label="Locked: set by you, kept when phases run again">
        <Box c="blue" style={{ display: "flex" }} aria-label="Locked">
          <IconLock size={15} stroke={1.8} />
        </Box>
      </Tooltip>
    );
  if (status === "open")
    return (
      <Tooltip label="Open question">
        <Box c="yellow" style={{ display: "flex" }} aria-label="Open question">
          <IconQuestionMark size={15} stroke={2.2} />
        </Box>
      </Tooltip>
    );
  return null;
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
    <Stack maw={860}>
      <Text size="sm" c="dimmed">
        General conventions the translation follows: punctuation, register, how foreign words or
        units are handled. The most important come first.
      </Text>
      {rules.length === 0 && (
        <Text size="md" c="dimmed">
          No style rules yet.
        </Text>
      )}
      <Stack gap={0}>
        {rules.map((r, i) => (
          <Group
            key={r.id}
            align="flex-start"
            wrap="nowrap"
            py="sm"
            style={{ borderBottom: "1px solid var(--tr-rule)" }}
          >
            <Text size="sm" w={24} c="dimmed" className="num" mt={2}>
              {i + 1}
            </Text>
            {editing === r.id ? (
              <Stack style={{ flex: 1 }} gap="xs">
                <Textarea
                  autosize
                  value={text}
                  onChange={(e) => setText(e.currentTarget.value)}
                  aria-label="Rule"
                />
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
              <Stack gap={4} style={{ flex: 1 }}>
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <Text size="md" className="serif" style={{ flex: 1 }}>
                    {r.rule}
                  </Text>
                  {r.status === "locked" && <StatusIcon status="locked" />}
                </Group>
                {r.examples.slice(0, 1).map((x) => (
                  <Text key={x.source} size="sm" c="dimmed" className="serif">
                    “{x.source}”{x.target ? ` becomes “${x.target}”` : ""}
                  </Text>
                ))}
              </Stack>
            )}
            {editing !== r.id && (
              <Group gap={2} wrap="nowrap">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
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
                  color="gray"
                  aria-label="Delete rule"
                  onClick={() => call(() => del<{ kb: Kb }>(`${base}/style-rules/${r.id}`))}
                >
                  <IconX size={14} />
                </ActionIcon>
              </Group>
            )}
          </Group>
        ))}
      </Stack>
      <Group align="flex-end" mt="sm">
        <TextInput
          style={{ flex: 1 }}
          label="Add a rule"
          placeholder="e.g. Keep imperial units; don't convert to metric."
          value={adding}
          onChange={(e) => setAdding(e.currentTarget.value)}
        />
        <Button
          variant="default"
          disabled={!adding.trim()}
          onClick={() =>
            call(async () => {
              const res = await post<{ kb: Kb }>(`${base}/style-rules`, { rule: adding });
              setAdding("");
              return res;
            })
          }
        >
          Add rule
        </Button>
      </Group>
    </Stack>
  );
}

function EntryTable({
  entries,
  onOpen,
  languages,
}: {
  entries: KbEntry[];
  onOpen: (e: KbEntry) => void;
  languages: { source: string; target: string };
}) {
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w="24%">{languages.source}</Table.Th>
            <Table.Th w="24%">{languages.target}</Table.Th>
            <Table.Th>Facts and notes</Table.Th>
            <Table.Th w={110}>Kind</Table.Th>
            <Table.Th w={32} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((e) => (
            <Table.Tr
              key={e.id}
              style={{ cursor: "pointer" }}
              tabIndex={0}
              onClick={() => onOpen(e)}
              onKeyDown={(k) => {
                if (k.key === "Enter") onOpen(e);
              }}
            >
              <Table.Td style={{ verticalAlign: "top" }}>
                <div className="tr-term" style={{ fontWeight: 600 }}>
                  {e.source}
                </div>
                {e.aliases.length > 0 && (
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    also {e.aliases.join(", ")}
                  </Text>
                )}
              </Table.Td>
              <Table.Td style={{ verticalAlign: "top" }}>
                <div className="tr-term">
                  {e.target ?? (
                    <Text span c="dimmed">
                      not decided
                    </Text>
                  )}
                </div>
                {e.treatment && e.treatment !== "translated" && (
                  <Text size="xs" c="dimmed" fs="italic">
                    {e.treatment}
                  </Text>
                )}
              </Table.Td>
              <Table.Td style={{ verticalAlign: "top" }}>
                {e.attributes.length > 0 && (
                  <Text size="sm" lineClamp={2}>
                    {e.attributes.map((a, i) => (
                      <span key={a.key}>
                        {i > 0 ? "; " : ""}
                        <Text span c="dimmed" size="sm">
                          {a.key.replaceAll("_", " ")}
                        </Text>{" "}
                        {a.value}
                      </span>
                    ))}
                  </Text>
                )}
                {(e.status === "open" ? e.question : e.note) && (
                  <Text size="sm" c={e.status === "open" ? "yellow" : "dimmed"} lineClamp={2}>
                    {e.status === "open" ? e.question : e.note}
                  </Text>
                )}
              </Table.Td>
              <Table.Td style={{ verticalAlign: "top" }}>
                <Text size="sm" c="dimmed">
                  {KIND_TEXT[e.kind] ?? e.kind}
                </Text>
              </Table.Td>
              <Table.Td style={{ verticalAlign: "top" }}>
                <StatusIcon status={e.status} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
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
  const project = useProject(pid).data?.project;
  const languages = {
    source: languageDisplayName(project?.sourceLang ?? "en"),
    target: project?.targetLangName || "Translation",
  };
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
  const [kind, setKind] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<{ entry: KbEntry; isNew: boolean } | null>(null);

  const entries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.kb.entries ?? [])
      .filter(
        (e) =>
          (!kind || e.kind === kind) &&
          (status === "all" || (status === "coined" ? e.origin === "phase3" : e.status === status)),
      )
      .filter(
        (e) =>
          !q ||
          [e.source, e.target ?? "", e.note, ...e.aliases].some((s) => s.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.source.localeCompare(b.source));
  }, [data, search, kind, status]);

  if (isLoading) return <Loader size="sm" />;
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
  const open = data.kb.entries.filter((e) => e.status === "open");
  const yours = Object.keys(data.overrides.entries).length;
  const open_ = (e: KbEntry) => setEditing({ entry: e, isNew: false });

  return (
    <>
      <Group justify="space-between" mb="lg" gap="md">
        <Text size="md" c="dimmed">
          {plural(data.kb.entries.length, "entry", "entries")} and{" "}
          {count(data.kb.styleRules.length, "style rule")}
          {yours > 0 ? `; ${yours} edited by you` : ""}.
        </Text>
        <Button onClick={() => setEditing({ entry: newEntry(), isNew: true })}>Add entry</Button>
      </Group>
      <Tabs defaultValue="entries" keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="entries">Entries</Tabs.Tab>
          <Tabs.Tab value="style">Style rules</Tabs.Tab>
          <Tabs.Tab value="preview">As the AI sees it</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="entries">
          {open.length > 0 && status === "all" && !search && !kind && (
            <Box mb="xl">
              <Text fw={600} mb={4}>
                {plural(open.length, "open question")}
              </Text>
              <Text size="sm" c="dimmed" mb="sm">
                The AI couldn't decide these yet. Answer them to lock the entries; later chapters
                may also answer them.
              </Text>
              <EntryTable entries={open} onOpen={open_} languages={languages} />
            </Box>
          )}
          <Group align="flex-end" mb="md" gap="sm">
            <TextInput
              aria-label="Search"
              placeholder="Search names, translations and notes"
              leftSection={<IconSearch size={15} stroke={1.7} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              style={{ flex: "1 1 260px" }}
            />
            <Select
              aria-label="Kind"
              placeholder="Every kind"
              data={KB_KINDS.map((k) => ({ value: k, label: KIND_TEXT[k] ?? k }))}
              value={kind}
              onChange={setKind}
              clearable
              w={180}
            />
            <SegmentedControl
              size="sm"
              value={status}
              onChange={setStatus}
              data={[
                { value: "all", label: "All" },
                { value: "open", label: "Open" },
                { value: "locked", label: "Yours" },
                { value: "auto", label: "Automatic" },
                // Terms coined while translating a book that became this pair.
                ...(data.kb.entries.some((e) => e.origin === "phase3")
                  ? [{ value: "coined", label: "Coined" }]
                  : []),
              ]}
            />
          </Group>
          {entries.length === 0 ? (
            <Text size="md" c="dimmed" py="lg">
              {data.kb.entries.length === 0
                ? "The knowledge base is empty. Run the phase to fill it, or add entries yourself."
                : "No entries match."}
            </Text>
          ) : (
            <EntryTable entries={entries} onOpen={open_} languages={languages} />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="style">
          <StyleRules rules={data.kb.styleRules} base={base} onChange={update} />
        </Tabs.Panel>
        <Tabs.Panel value="preview">
          <Stack maw={980}>
            <Text size="sm" c="dimmed">
              Exactly what goes into the requests
              {preview.data ? `, about ${preview.data.tokens.toLocaleString()} tokens` : ""}.
            </Text>
            <ScrollArea.Autosize mah="70vh">
              <Code block>{preview.data?.text || "(empty)"}</Code>
            </ScrollArea.Autosize>
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
        onSaveUnlocked={(e) =>
          call(
            () => put<{ kb: Kb }>(`${base}/entries/${e.id}/unlocked`, e),
            "Entry saved, not locked.",
          )
        }
        onUnlock={(e) =>
          call(() => post<{ kb: Kb }>(`${base}/entries/${e.id}/unlock`), "Entry unlocked.")
        }
        onDelete={(e) => call(() => del<{ kb: Kb }>(`${base}/entries/${e.id}`), "Entry deleted.")}
        onAsk={(e, modelId) => post<KbAnswer>(`${base}/entries/${e.id}/ask`, { modelId })}
        languages={languages}
      />
    </>
  );
}
