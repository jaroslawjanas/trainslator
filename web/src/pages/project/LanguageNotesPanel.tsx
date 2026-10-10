import { Box, Button, Group, Select, Stack, Text, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { post, put } from "../../api/client.ts";
import type { Job, Project } from "../../api/types.ts";
import { JobRow } from "../../components/JobsIndicator.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { ACTIVE_JOB } from "../../lib/stages.ts";
import { useSettings } from "../SettingsPage.tsx";

export function LanguageNotesPanel({
  project,
  notes,
  job,
}: {
  project: Project;
  notes: string;
  job: Job | undefined;
}) {
  const client = useQueryClient();
  const [text, setText] = useState(notes);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(notes), [notes]);
  const dirty = text !== notes;
  const running = job !== undefined && ACTIVE_JOB.includes(job.status);
  // The model that drafts: the utility step's unless you pick another.
  const settings = useSettings().data?.settings;
  const [modelId, setModelId] = useState<string | null>(null);
  const chosen = modelId ?? settings?.steps.utility.modelId ?? settings?.models[0]?.id ?? null;
  const models = (settings?.models ?? []).map((m) => ({
    value: m.id,
    label: `${m.label || m.modelName} (${settings?.connections.find((c) => c.id === m.connectionId)?.name ?? "?"})`,
  }));

  const generate = async () => {
    if (notes.trim() && !window.confirm("Replace the current notes with a new draft?")) return;
    try {
      await post(`/api/projects/${project.id}/language-notes/generate`, { modelId: chosen });
      void client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't start", message: (e as Error).message });
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      await put(`/api/projects/${project.id}/language-notes`, { markdown: text });
      await client.invalidateQueries({ queryKey: ["project", project.id] });
      notifications.show({ color: "green", message: "Notes saved." });
      setEditing(false);
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        context={project.name}
        contextTo={`/projects/${project.id}`}
        title="Language notes"
        description={`What a translator into ${project.targetLangName} has to keep track of: grammatical gender, forms of address, how names are written. The notes go into every request.`}
        actions={
          !editing && (
            <>
              <Select
                aria-label="Model that drafts the notes"
                data={models}
                value={chosen}
                onChange={setModelId}
                allowDeselect={false}
                disabled={running}
                w={280}
              />
              <Button variant="default" onClick={generate} loading={running} disabled={!chosen}>
                {notes.trim() ? "Draft again with AI" : "Draft with AI"}
              </Button>
              <Button
                variant={notes.trim() ? "default" : "filled"}
                onClick={() => setEditing(true)}
              >
                {notes.trim() ? "Edit" : "Write notes"}
              </Button>
            </>
          )
        }
      />
      {job && (running || job.status === "failed") && (
        <Box maw={720} mb="lg">
          <JobRow job={job} />
        </Box>
      )}
      {editing ? (
        <Stack maw={860}>
          <Textarea
            aria-label="Language notes (Markdown)"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            autosize
            minRows={14}
            maxRows={40}
            styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 13 } }}
          />
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              Markdown: # headings, - lists, **bold**.
            </Text>
            <Group gap="xs">
              <Button
                variant="default"
                onClick={() => {
                  setText(notes);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button disabled={!dirty} loading={saving} onClick={save}>
                Save notes
              </Button>
            </Group>
          </Group>
        </Stack>
      ) : notes.trim() ? (
        <Markdown source={notes} />
      ) : (
        <Text size="md" c="dimmed" maw={620}>
          No notes yet. Let the AI draft them for {project.targetLangName}, or write your own.
        </Text>
      )}
    </>
  );
}
