import {
  Alert,
  Anchor,
  Box,
  Button,
  Group,
  List,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { languageDisplayName } from "../../../src/shared/languages.ts";
import { get, post } from "../api/client.ts";
import type { Project, ProjectSummary } from "../api/types.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { listText, plural, relativeTime } from "../lib/format.ts";

/** Primary language subtag: "pt-BR" → "pt". */
const primary = (tag: string) => tag.split("-")[0]!.toLowerCase();

function NewProjectModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const languages = useQuery({
    queryKey: ["languages"],
    queryFn: () =>
      get<{
        languages: { tag: string; name: string }[];
        sources: { tag: string; name: string }[];
      }>("/api/projects/languages"),
  });
  const [name, setName] = useState("");
  const [source, setSource] = useState("en");
  const [target, setTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => {
    // The source language can't also be the target.
    const list = (languages.data?.languages ?? [])
      .filter((l) => primary(l.tag) !== primary(source))
      .map((l) => ({ value: l.tag, label: `${l.name} (${l.tag})` }));
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
  }, [languages.data, search, source]);
  const sources = (languages.data?.sources ?? [{ tag: "en", name: "English" }]).map((l) => ({
    value: l.tag,
    label: l.name,
  }));

  return (
    <Modal opened={opened} onClose={onClose} title="New project">
      <Stack>
        <Text size="sm" c="dimmed">
          A project translates books from one language into another. You add reference pairs and
          books inside it.
        </Text>
        <TextInput
          label="Name"
          placeholder="e.g. Fantasy series into Polish"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          data-autofocus
        />
        <Select
          label="Translate from"
          description="The language of the books, and of the originals in your reference pairs."
          data={sources}
          value={source}
          allowDeselect={false}
          onChange={(v) => {
            if (!v) return;
            setSource(v);
            if (target && primary(target) === primary(v)) setTarget(null);
          }}
        />
        <Select
          label="Translate into"
          placeholder="Search, or type a language code"
          searchable
          data={options}
          value={target}
          onChange={setTarget}
          searchValue={search}
          onSearchChange={setSearch}
          nothingFoundMessage="Type a language code such as pl, pt-BR or zh-Hant"
        />
        <Group justify="flex-end" mt="sm">
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
                  sourceLang: source,
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
            Create project
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function FirstSteps({ onCreate }: { onCreate: () => void }) {
  return (
    <Box maw={620}>
      <Text size="lg" className="serif" mb="md">
        Three steps to a first translation:
      </Text>
      <List type="ordered" spacing="sm" size="md">
        <List.Item>
          <Anchor component={Link} to="/settings">
            Connect an AI provider
          </Anchor>{" "}
          in Settings, add a model, and choose it for each step.
        </List.Item>
        <List.Item>
          <Anchor component="button" onClick={onCreate}>
            Create a project
          </Anchor>{" "}
          for the languages you translate from and into.
        </List.Item>
        <List.Item>
          Add reference pairs (a book with its published translation), then the book you want
          translated.
        </List.Item>
      </List>
    </Box>
  );
}

export function ProjectsPage() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => get<{ projects: ProjectSummary[] }>("/api/projects"),
  });
  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project translates books from one language into another, learning from the reference pairs you give it."
        actions={<Button onClick={() => setOpen(true)}>New project</Button>}
      />
      {isLoading && <Loader size="sm" />}
      {error && <Alert color="red">{(error as Error).message}</Alert>}
      {data && data.projects.length === 0 && <FirstSteps onCreate={() => setOpen(true)} />}
      {data && data.projects.length > 0 && (
        <Box maw={860} className="tr-list-flush">
          {data.projects.map((p) => {
            const contents = [
              p.bookCount > 0 ? plural(p.bookCount, "book") : null,
              p.pairCount > 0 ? plural(p.pairCount, "reference pair") : null,
            ].filter((x): x is string => x !== null);
            return (
              <Link key={p.id} to={`/projects/${p.id}`} className="tr-row-link">
                <Group justify="space-between" align="baseline" wrap="nowrap" gap="md">
                  <div className="tr-row-title">{p.name}</div>
                  <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                    Updated {relativeTime(p.updatedAt)}
                  </Text>
                </Group>
                <Text size="sm" c="dimmed" mt={4}>
                  {languageDisplayName(p.sourceLang)} into {p.targetLangName}.{" "}
                  {contents.length > 0 ? `${listText(contents)}.` : "Nothing added yet."}
                </Text>
              </Link>
            );
          })}
        </Box>
      )}
      <NewProjectModal opened={open} onClose={() => setOpen(false)} />
    </>
  );
}
