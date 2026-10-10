import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { get, post } from "../api/client.ts";
import type { Project, ProjectSummary } from "../api/types.ts";

function NewProjectModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const languages = useQuery({
    queryKey: ["languages"],
    queryFn: () => get<{ languages: { tag: string; name: string }[] }>("/api/projects/languages"),
  });
  const [name, setName] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => {
    const list = (languages.data?.languages ?? []).map((l) => ({
      value: l.tag,
      label: `${l.name} (${l.tag})`,
    }));
    const typed = search.trim();
    // Any BCP-47 code can be typed in, even if it's not in the list.
    if (
      typed &&
      /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(typed) &&
      !list.some((o) => o.value.toLowerCase() === typed.toLowerCase())
    ) {
      list.unshift({ value: typed, label: `Use code "${typed}"` });
    }
    return list;
  }, [languages.data, search]);

  return (
    <Modal opened={opened} onClose={onClose} title="New project">
      <Stack>
        <Text size="sm" c="dimmed">
          A project translates books from English into one target language. Reference pairs and
          books are added inside it.
        </Text>
        <TextInput
          label="Name"
          placeholder="e.g. Fantasy series into Polish"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <TextInput
          label="Source language"
          value="English"
          disabled
          description="Only English is supported for now."
        />
        <Select
          label="Target language"
          placeholder="Search or type a language code"
          searchable
          data={options}
          value={target}
          onChange={setTarget}
          searchValue={search}
          onSearchChange={setSearch}
          nothingFoundMessage="Type a language code such as pl, pt-BR or zh-Hant"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!target}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                const res = await post<{ project: Project }>("/api/projects", {
                  name,
                  targetLang: target,
                });
                await client.invalidateQueries({ queryKey: ["projects"] });
                onClose();
                navigate(`/projects/${res.project.id}`);
              } catch (e) {
                notifications.show({
                  color: "red",
                  title: "Couldn't create the project",
                  message: (e as Error).message,
                });
              } finally {
                setSaving(false);
              }
            }}
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function ProjectsPage() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => get<{ projects: ProjectSummary[] }>("/api/projects"),
  });
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Projects</Title>
        <Button onClick={() => setOpen(true)}>New project</Button>
      </Group>
      {isLoading && <Loader />}
      {error && <Alert color="red">{(error as Error).message}</Alert>}
      {data && data.projects.length === 0 && (
        <Alert title="Start here" color="blue">
          <Stack gap="xs">
            <Text size="sm">
              1. In Settings, add a connection to an AI provider, add models and choose a model for
              each step.
            </Text>
            <Text size="sm">2. Create a project for your target language.</Text>
            <Text size="sm">
              3. Add reference pairs (an English book and its human translation) and the book you
              want translated.
            </Text>
          </Stack>
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {data?.projects.map((p) => (
          <Card
            key={p.id}
            withBorder
            component={Link}
            to={`/projects/${p.id}`}
            style={{ textDecoration: "none" }}
          >
            <Stack gap={6}>
              <Group justify="space-between">
                <Text fw={600}>{p.name}</Text>
                <Badge variant="light">English → {p.targetLangName}</Badge>
              </Group>
              <Text size="sm" c="dimmed">
                {p.pairCount} reference pair{p.pairCount === 1 ? "" : "s"} · {p.bookCount} book
                {p.bookCount === 1 ? "" : "s"}
              </Text>
              <Text size="xs" c="dimmed">
                Updated {new Date(p.updatedAt).toLocaleString()}
              </Text>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>
      <NewProjectModal opened={open} onClose={() => setOpen(false)} />
    </Stack>
  );
}
