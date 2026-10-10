import {
  Alert,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { del, get } from "../api/client.ts";
import { DiagnosticsList } from "../components/DiagnosticsList.tsx";
import { BuildPanel } from "./book/BuildPanel.tsx";
import { Phase2Panel } from "./book/Phase2Panel.tsx";
import { SetupPanel } from "./book/SetupPanel.tsx";
import { TranslatePanel } from "./book/TranslatePanel.tsx";
import type { BookDetail } from "./book/types.ts";
import { KbEditor } from "./kb/KbEditor.tsx";
import { useProject } from "./ProjectPage.tsx";

export function BookPage() {
  const { pid = "", bookId = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const project = useProject(pid);
  const { data, isLoading, error } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => get<BookDetail>(`/api/projects/${pid}/books/${bookId}`),
  });
  if (isLoading) return <Loader />;
  if (error || !data)
    return <Alert color="red">{(error as Error)?.message ?? "Book not found."}</Alert>;
  const { book, structure } = data;

  return (
    <Stack>
      <Breadcrumbs>
        <Anchor component={Link} to="/projects">
          Projects
        </Anchor>
        <Anchor component={Link} to={`/projects/${pid}`}>
          {project.data?.project.name ?? "Project"}
        </Anchor>
        <Text>{book.title}</Text>
      </Breadcrumbs>
      <Group justify="space-between">
        <div>
          <Title order={2}>{book.title}</Title>
          <Text size="sm" c="dimmed">
            {book.sourceFileName} · {structure.totalWords.toLocaleString()} words · EPUB{" "}
            {structure.version}
            {project.data ? ` · into ${project.data.project.targetLangName}` : ""}
          </Text>
        </div>
        <Group>
          {book.build.builtAt && (
            <Badge color="green" variant="light">
              built
            </Badge>
          )}
          <Button
            variant="subtle"
            color="red"
            onClick={async () => {
              if (!window.confirm("Delete this book with its knowledge base and translation?"))
                return;
              try {
                await del(`/api/projects/${pid}/books/${bookId}`);
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
        </Group>
      </Group>
      {structure.diagnostics.length > 0 && <DiagnosticsList diagnostics={structure.diagnostics} />}
      <Tabs defaultValue={book.phase3.state !== "none" ? "translate" : "setup"} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="setup">1 · Setup</Tabs.Tab>
          <Tabs.Tab value="phase2">2 · Phase 2</Tabs.Tab>
          <Tabs.Tab value="kb">3 · Knowledge base</Tabs.Tab>
          <Tabs.Tab value="translate">4 · Translate &amp; review</Tabs.Tab>
          <Tabs.Tab value="build">5 · Build</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="setup" pt="md">
          <SetupPanel pid={pid} detail={data} />
        </Tabs.Panel>
        <Tabs.Panel value="phase2" pt="md">
          <Phase2Panel pid={pid} detail={data} />
        </Tabs.Panel>
        <Tabs.Panel value="kb" pt="md">
          <KbEditor pid={pid} scope="book" targetId={bookId} />
        </Tabs.Panel>
        <Tabs.Panel value="translate" pt="md">
          <TranslatePanel pid={pid} detail={data} />
        </Tabs.Panel>
        <Tabs.Panel value="build" pt="md">
          <BuildPanel pid={pid} detail={data} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
