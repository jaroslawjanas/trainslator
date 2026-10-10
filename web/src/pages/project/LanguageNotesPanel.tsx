import { Alert, Button, Group, Stack, Text, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { post, put } from "../../api/client.ts";
import type { Job, Project } from "../../api/types.ts";
import { JobRow } from "../../components/JobsIndicator.tsx";

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
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(notes), [notes]);
  const dirty = text !== notes;
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Notes about {project.targetLangName} that go into every prompt: what a translator must track
        (grammatical gender, formal address, how names are written …). Let the AI draft them, then
        edit as you like.
      </Text>
      {!notes.trim() && !job && (
        <Alert color="blue" title="No notes yet">
          Generate a first draft, or write your own.
        </Alert>
      )}
      {job && ["queued", "running", "pausing", "failed"].includes(job.status) && (
        <JobRow job={job} />
      )}
      <Textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        autosize
        minRows={10}
        maxRows={30}
        classNames={{ input: "mono" }}
      />
      <Group justify="space-between">
        <Button
          variant="light"
          onClick={async () => {
            if (notes.trim() && !window.confirm("Replace the current notes with a new draft?"))
              return;
            try {
              await post(`/api/projects/${project.id}/language-notes/generate`);
              void client.invalidateQueries({ queryKey: ["jobs"] });
            } catch (e) {
              notifications.show({
                color: "red",
                title: "Couldn't start",
                message: (e as Error).message,
              });
            }
          }}
        >
          {notes.trim() ? "Regenerate with AI" : "Generate with AI"}
        </Button>
        <Group>
          <Button variant="default" disabled={!dirty} onClick={() => setText(notes)}>
            Undo
          </Button>
          <Button
            disabled={!dirty}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await put(`/api/projects/${project.id}/language-notes`, { markdown: text });
                await client.invalidateQueries({ queryKey: ["project", project.id] });
                notifications.show({ color: "green", message: "Notes saved." });
              } catch (e) {
                notifications.show({
                  color: "red",
                  title: "Couldn't save",
                  message: (e as Error).message,
                });
              } finally {
                setSaving(false);
              }
            }}
          >
            Save notes
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
