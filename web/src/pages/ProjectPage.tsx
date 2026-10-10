import {
  Alert,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  FileInput,
  Group,
  Loader,
  Modal,
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
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { del, get, patch, post, upload } from "../api/client.ts";
import type { Book, Job, Pair, ProjectDetail } from "../api/types.ts";
import { JobRow, useJobs } from "../components/JobsIndicator.tsx";
import { LanguageNotesPanel } from "./project/LanguageNotesPanel.tsx";
import { UsagePanel } from "./project/UsagePanel.tsx";

export function useProject(pid: string) {
  return useQuery({
    queryKey: ["project", pid],
    queryFn: () => get<ProjectDetail>(`/api/projects/${pid}`),
  });
}

function phaseBadge(state: string, label: string) {
  const color =
    state === "done"
      ? "green"
      : state === "running"
        ? "blue"
        : state === "failed"
          ? "red"
          : state === "done_with_errors"
            ? "yellow"
            : "gray";
  return (
    <Badge size="sm" variant="light" color={color}>
      {label}: {state === "none" ? "not run" : state.replaceAll("_", " ")}
    </Badge>
  );
}

function UploadPairModal({
  pid,
  opened,
  onClose,
}: {
  pid: string;
  opened: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [source, setSource] = useState<File | null>(null);
  const [target, setTarget] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title="Add a reference pair">
      <Stack>
        <Text size="sm" c="dimmed">
          An English book and its published human translation. Both must be DRM-free EPUB files.
        </Text>
        <FileInput
          label="English original (EPUB)"
          accept=".epub,application/epub+zip"
          value={source}
          onChange={setSource}
        />
        <FileInput
          label="Human translation (EPUB)"
          accept=".epub,application/epub+zip"
          value={target}
          onChange={setTarget}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!source || !target}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const form = new FormData();
                form.set("source", source!);
                form.set("target", target!);
                const res = await upload<{ pair: Pair }>(`/api/projects/${pid}/pairs`, form);
                await client.invalidateQueries({ queryKey: ["project", pid] });
                onClose();
                navigate(`/projects/${pid}/pairs/${res.pair.id}`);
              } catch (e) {
                notifications.show({
                  color: "red",
                  title: "Couldn't add the pair",
                  message: (e as Error).message,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            Add pair
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function UploadBookModal({
  pid,
  opened,
  onClose,
}: {
  pid: string;
  opened: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title="Add a book to translate">
      <Stack>
        <FileInput
          label="English book (DRM-free EPUB)"
          accept=".epub,application/epub+zip"
          value={file}
          onChange={setFile}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!file}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const form = new FormData();
                form.set("file", file!);
                const res = await upload<{ book: Book }>(`/api/projects/${pid}/books`, form);
                await client.invalidateQueries({ queryKey: ["project", pid] });
                onClose();
                navigate(`/projects/${pid}/books/${res.book.id}`);
              } catch (e) {
                notifications.show({
                  color: "red",
                  title: "Couldn't add the book",
                  message: (e as Error).message,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            Add book
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ProjectOptions({ detail }: { detail: ProjectDetail }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { project } = detail;
  const [name, setName] = useState(project.name);
  const save = async (body: Record<string, unknown>) => {
    try {
      await patch(`/api/projects/${project.id}`, body);
      await client.invalidateQueries({ queryKey: ["project", project.id] });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    }
  };
  return (
    <Stack maw={640}>
      <Group align="flex-end">
        <TextInput
          label="Project name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Button disabled={name === project.name || !name.trim()} onClick={() => save({ name })}>
          Rename
        </Button>
      </Group>
      <Switch
        label="Pause for review after each phase"
        description="When on, finished phases wait for you to check the knowledge base before the next one starts."
        checked={project.options.pauseAfterPhase}
        onChange={(e) => save({ pauseAfterPhase: e.currentTarget.checked })}
      />
      <Group>
        <Button
          variant="default"
          onClick={async () => {
            const res = await post<{ removed: number }>(`/api/projects/${project.id}/cache/clear`);
            notifications.show({ message: `Cleared ${res.removed} cached answers.` });
          }}
        >
          Clear cached AI answers
        </Button>
        <Button
          color="red"
          variant="light"
          onClick={async () => {
            if (
              !window.confirm(
                `Delete "${project.name}" with all its books, knowledge bases and translations?`,
              )
            )
              return;
            try {
              await del(`/api/projects/${project.id}`);
              await client.invalidateQueries({ queryKey: ["projects"] });
              navigate("/projects");
            } catch (e) {
              notifications.show({
                color: "red",
                title: "Couldn't delete",
                message: (e as Error).message,
              });
            }
          }}
        >
          Delete project
        </Button>
      </Group>
    </Stack>
  );
}

export function ProjectPage() {
  const { pid = "" } = useParams();
  const { data, isLoading, error } = useProject(pid);
  const jobs = useJobs();
  const [pairOpen, setPairOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  if (isLoading) return <Loader />;
  if (error || !data)
    return <Alert color="red">{(error as Error)?.message ?? "Project not found."}</Alert>;
  const { project, pairs, books } = data;
  const projectJobs: Job[] = (jobs.data?.jobs ?? []).filter((j) => j.projectId === pid);
  const notesJob = projectJobs.find((j) => j.type === "language-notes");
  const active = projectJobs.filter((j) =>
    ["queued", "running", "pausing", "paused", "interrupted"].includes(j.status),
  );

  return (
    <Stack>
      <Breadcrumbs>
        <Anchor component={Link} to="/projects">
          Projects
        </Anchor>
        <Text>{project.name}</Text>
      </Breadcrumbs>
      <Group justify="space-between">
        <Title order={2}>{project.name}</Title>
        <Badge size="lg" variant="light">
          English → {project.targetLangName} ({project.targetLang})
        </Badge>
      </Group>
      {active.length > 0 && (
        <Card withBorder>
          <Stack>
            {active.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </Stack>
        </Card>
      )}
      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="overview">Books</Tabs.Tab>
          <Tabs.Tab value="notes">Language notes</Tabs.Tab>
          <Tabs.Tab value="usage">Usage</Tabs.Tab>
          <Tabs.Tab value="options">Options</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" pt="md">
          <Stack gap="xl">
            <Stack>
              <Group justify="space-between">
                <div>
                  <Title order={4}>Reference pairs</Title>
                  <Text size="sm" c="dimmed">
                    English books with their human translations. Phase 1 learns names, terms and
                    style from them.
                  </Text>
                </div>
                <Button variant="light" onClick={() => setPairOpen(true)}>
                  Add reference pair
                </Button>
              </Group>
              {pairs.length === 0 ? (
                <Text size="sm" c="dimmed">
                  None yet. Reference pairs are optional, but they make translations consistent with
                  earlier human work.
                </Text>
              ) : (
                <Table>
                  <Table.Tbody>
                    {pairs.map((p) => (
                      <Table.Tr key={p.id}>
                        <Table.Td>
                          <Anchor component={Link} to={`/projects/${pid}/pairs/${p.id}`} fw={500}>
                            {p.title}
                          </Anchor>
                          <Text size="xs" c="dimmed">
                            {p.sourceFileName} + {p.targetFileName}
                          </Text>
                        </Table.Td>
                        <Table.Td>{phaseBadge(p.phase1.state, "Phase 1")}</Table.Td>
                        <Table.Td>
                          <Text size="sm">
                            {p.phase1.entries !== null ? `${p.phase1.entries} KB entries` : ""}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
            <Stack>
              <Group justify="space-between">
                <div>
                  <Title order={4}>Books to translate</Title>
                  <Text size="sm" c="dimmed">
                    Phase 2 reads the book and builds its knowledge base; phase 3 translates it.
                  </Text>
                </div>
                <Button onClick={() => setBookOpen(true)}>Add book</Button>
              </Group>
              {books.length === 0 ? (
                <Text size="sm" c="dimmed">
                  None yet.
                </Text>
              ) : (
                <Table>
                  <Table.Tbody>
                    {books.map((b) => (
                      <Table.Tr key={b.id}>
                        <Table.Td>
                          <Anchor component={Link} to={`/projects/${pid}/books/${b.id}`} fw={500}>
                            {b.title}
                          </Anchor>
                          <Text size="xs" c="dimmed">
                            {b.sourceFileName}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap="xs">
                            {phaseBadge(b.phase2.state, "Phase 2")}
                            {phaseBadge(b.phase3.state, "Phase 3")}
                            {b.build.builtAt && (
                              <Badge size="sm" color="green" variant="light">
                                built
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="notes" pt="md">
          <LanguageNotesPanel project={project} notes={data.languageNotes} job={notesJob} />
        </Tabs.Panel>
        <Tabs.Panel value="usage" pt="md">
          <UsagePanel projectId={pid} />
        </Tabs.Panel>
        <Tabs.Panel value="options" pt="md">
          <ProjectOptions detail={data} />
        </Tabs.Panel>
      </Tabs>
      <UploadPairModal pid={pid} opened={pairOpen} onClose={() => setPairOpen(false)} />
      <UploadBookModal pid={pid} opened={bookOpen} onClose={() => setBookOpen(false)} />
    </Stack>
  );
}
