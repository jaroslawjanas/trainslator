import {
  Alert,
  Box,
  Button,
  FileInput,
  Group,
  Loader,
  Modal,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { languageDisplayName } from "../../../src/shared/languages.ts";
import { del, get, patch, post, upload } from "../api/client.ts";
import type { Book, Job, Pair, ProjectDetail } from "../api/types.ts";
import { useJobs } from "../components/JobsIndicator.tsx";
import { PageHeader, Section } from "../components/PageHeader.tsx";
import { StageMark } from "../components/StageMark.tsx";
import { displayTitle, plural, withArticle } from "../lib/format.ts";
import { BOOK_STAGES, type MarkState, PAIR_STAGES } from "../lib/stages.ts";
import { LanguageNotesPanel } from "./project/LanguageNotesPanel.tsx";
import { UsagePanel } from "./project/UsagePanel.tsx";

export function useProject(pid: string) {
  return useQuery({
    queryKey: ["project", pid],
    queryFn: () => get<ProjectDetail>(`/api/projects/${pid}`),
    enabled: Boolean(pid),
  });
}

/** The name of the project's source language: "English", "German". */
export function useSourceName(pid: string): string {
  const project = useProject(pid).data?.project;
  return project ? languageDisplayName(project.sourceLang) : "original";
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
  const sourceName = useSourceName(pid);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [source, setSource] = useState<File | null>(null);
  const [target, setTarget] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title="Add a reference pair">
      <Stack>
        <Text size="sm" c="dimmed">
          {withArticle(sourceName)} book and its published human translation, both as DRM-free EPUB
          files. The AI learns the translator's choices from them.
        </Text>
        <FileInput
          label={`${sourceName} original`}
          placeholder="Choose an EPUB file"
          accept=".epub,application/epub+zip"
          value={source}
          onChange={setSource}
        />
        <FileInput
          label="Published translation"
          placeholder="Choose an EPUB file"
          accept=".epub,application/epub+zip"
          value={target}
          onChange={setTarget}
        />
        <Group justify="flex-end" mt="sm">
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
                navigate(`/projects/${pid}/pairs/${res.pair.id}/alignment`);
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
  const source = useSourceName(pid);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title="Add a book to translate">
      <Stack>
        <FileInput
          label={`${source} book`}
          description="A DRM-free EPUB file."
          placeholder="Choose an EPUB file"
          accept=".epub,application/epub+zip"
          value={file}
          onChange={setFile}
        />
        <Group justify="flex-end" mt="sm">
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
                navigate(`/projects/${pid}/books/${res.book.id}/setup`);
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

function Steps({ items }: { items: { label: string; mark: MarkState }[] }) {
  return (
    <div className="tr-steps">
      {items.map((s) => (
        <span key={s.label} className="tr-step" data-state={s.mark}>
          <StageMark state={s.mark} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Overview({
  detail,
  jobs,
  onAddBook,
  onAddPair,
}: {
  detail: ProjectDetail;
  jobs: Job[];
  onAddBook: () => void;
  onAddPair: () => void;
}) {
  const { project, pairs, books } = detail;
  const base = `/projects/${project.id}`;
  return (
    <>
      <PageHeader
        title={project.name}
        description={`Translates books from ${languageDisplayName(project.sourceLang)} into ${project.targetLangName}, consistent with the reference pairs below.`}
        actions={
          <>
            <Button variant="default" onClick={onAddPair}>
              Add reference pair
            </Button>
            <Button onClick={onAddBook}>Add book</Button>
          </>
        }
      />
      <Box maw={920}>
        <Section
          title="Books"
          description="Each book is read first (phase 2), then translated (phase 3) and built as a new EPUB."
        >
          {books.length === 0 ? (
            <Text size="md" c="dimmed">
              No books yet. Add the {languageDisplayName(project.sourceLang)} book you want
              translated.
            </Text>
          ) : (
            <div>
              {books.map((b) => (
                <Link key={b.id} to={`${base}/books/${b.id}`} className="tr-row-link">
                  <div className="tr-row-title">{displayTitle(b.title)}</div>
                  <Text size="xs" c="dimmed" mt={2} mb={8}>
                    {b.sourceFileName}
                  </Text>
                  <Steps
                    items={BOOK_STAGES.filter((s) =>
                      ["read", "translate", "build"].includes(s.key),
                    ).map((s) => ({ label: s.label, mark: s.mark({ book: b, jobs }) }))}
                  />
                </Link>
              ))}
            </div>
          )}
        </Section>
        <Section
          title="Reference pairs"
          description={`${languageDisplayName(project.sourceLang)} books with their published translations. Phase 1 learns names, terms and style from them.`}
        >
          {pairs.length === 0 ? (
            <Text size="md" c="dimmed">
              No reference pairs yet. They're optional, but with them the translation follows the
              choices of earlier human translators.
            </Text>
          ) : (
            <div>
              {pairs.map((p) => {
                const learning = PAIR_STAGES.find((s) => s.key === "learn")!;
                const mark = learning.mark({ pair: p, jobs });
                return (
                  <Link key={p.id} to={`${base}/pairs/${p.id}`} className="tr-row-link">
                    <div className="tr-row-title">{displayTitle(p.title)}</div>
                    <Text size="xs" c="dimmed" mt={2} mb={8}>
                      {p.sourceFileName} with {p.targetFileName}
                    </Text>
                    <Steps
                      items={[
                        {
                          label:
                            p.phase1.entries !== null
                              ? `${p.fromBook ? "Made from a book: " : "Learned "}${plural(p.phase1.entries, "entry", "entries")}${p.phase1.state === "done_with_errors" ? ", some chapters failed" : ""}`
                              : "Not learned yet",
                          mark,
                        },
                      ]}
                    />
                  </Link>
                );
              })}
            </div>
          )}
        </Section>
      </Box>
    </>
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
      await client.invalidateQueries({ queryKey: ["projects"] });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    }
  };
  return (
    <>
      <PageHeader
        context={project.name}
        contextTo={`/projects/${project.id}`}
        title="Project settings"
      />
      <Box maw={640}>
        <Section title="Name">
          <Group align="flex-end">
            <TextInput
              aria-label="Project name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button
              variant="default"
              disabled={name === project.name || !name.trim()}
              onClick={() => save({ name })}
            >
              Rename
            </Button>
          </Group>
        </Section>
        <Section
          title="Languages"
          description="Set when the project was created. To translate between other languages, create a new project."
        >
          <Text size="sm">
            From {languageDisplayName(project.sourceLang)} into {project.targetLangName}
          </Text>
        </Section>
        <Section title="Review">
          <Switch
            label="Pause for review after each phase"
            description="Finished phases wait for you to check the knowledge base before the next one starts."
            checked={project.options.pauseAfterPhase}
            onChange={(e) => save({ pauseAfterPhase: e.currentTarget.checked })}
          />
        </Section>
        <Section
          title="Saved AI answers"
          description="Answers that passed the checks are kept and reused when exactly the same request repeats. Clear them to make every step ask again."
        >
          <Button
            variant="default"
            onClick={async () => {
              const res = await post<{ removed: number }>(
                `/api/projects/${project.id}/cache/clear`,
              );
              notifications.show({ message: `Cleared ${plural(res.removed, "saved answer")}.` });
            }}
          >
            Clear saved answers
          </Button>
        </Section>
        <Section
          title="Delete project"
          description="Deletes the project folder with all its books, knowledge bases and translations. This can't be undone."
        >
          <Button
            color="red"
            variant="outline"
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
        </Section>
      </Box>
    </>
  );
}

export function ProjectPage() {
  const { pid = "", section = "" } = useParams();
  const { data, isLoading, error } = useProject(pid);
  const jobs = useJobs();
  const [pairOpen, setPairOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  if (isLoading) return <Loader size="sm" mt="xl" />;
  if (error || !data)
    return (
      <Alert color="red" mt="xl">
        {(error as Error)?.message ?? "Project not found."}
      </Alert>
    );
  const projectJobs: Job[] = (jobs.data?.jobs ?? []).filter((j) => j.projectId === pid);

  return (
    <>
      {section === "notes" ? (
        <LanguageNotesPanel
          project={data.project}
          notes={data.languageNotes}
          job={projectJobs.find((j) => j.type === "language-notes")}
        />
      ) : section === "usage" ? (
        <UsagePanel project={data.project} />
      ) : section === "options" ? (
        <ProjectOptions detail={data} />
      ) : (
        <Overview
          detail={data}
          jobs={projectJobs}
          onAddBook={() => setBookOpen(true)}
          onAddPair={() => setPairOpen(true)}
        />
      )}
      <UploadPairModal pid={pid} opened={pairOpen} onClose={() => setPairOpen(false)} />
      <UploadBookModal pid={pid} opened={bookOpen} onClose={() => setBookOpen(false)} />
    </>
  );
}
