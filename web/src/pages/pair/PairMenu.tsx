import { Alert, Button, FileInput, Group, Menu, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconChevronDown, IconFileUpload, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { del, upload } from "../../api/client.ts";
import { useJobs } from "../../components/JobsIndicator.tsx";
import { ACTIVE_JOB } from "../../lib/stages.ts";
import { useSourceName } from "../ProjectPage.tsx";
import type { PairDetail } from "./AlignmentPanel.tsx";

type Side = "source" | "target";

function ReplaceModal({
  pid,
  pair,
  side,
  onClose,
}: {
  pid: string;
  pair: PairDetail["pair"];
  side: Side | null;
  onClose: () => void;
}) {
  const source = useSourceName(pid);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const which = side === "source" ? `${source} original` : "translation";
  const close = () => {
    setFile(null);
    onClose();
  };
  return (
    <Modal opened={side !== null} onClose={close} title={`Replace the ${which}`}>
      <Stack>
        <Text size="sm">
          Now: <b>{side === "source" ? pair.sourceFileName : pair.targetFileName}</b>
        </Text>
        <FileInput
          label={side === "source" ? `${source} book` : "Published translation"}
          description="A DRM-free EPUB file."
          placeholder="Choose an EPUB file"
          accept=".epub,application/epub+zip"
          value={file}
          onChange={setFile}
        />
        <Alert color="gray">
          The chapters are matched again, so check the alignment and confirm it. The knowledge base
          and your edits to it stay as they are until you run Learning again, which reads the
          chapters again (a chapter pair whose text and row are unchanged may be reused).
        </Alert>
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!file}
            loading={busy}
            onClick={async () => {
              if (!side || !file) return;
              setBusy(true);
              try {
                const form = new FormData();
                form.set("file", file);
                await upload(`/api/projects/${pid}/pairs/${pair.id}/files/${side}`, form);
                await client.invalidateQueries({ queryKey: ["pair", pair.id] });
                await client.invalidateQueries({ queryKey: ["project", pid] });
                notifications.show({
                  color: "green",
                  message: "Book replaced. Check the alignment and confirm it.",
                });
                close();
                navigate(`/projects/${pid}/pairs/${pair.id}/alignment`);
              } catch (e) {
                notifications.show({
                  color: "red",
                  title: "Couldn't replace the book",
                  message: (e as Error).message,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            Replace
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The pair's files and the actions on the whole pair, in the page header. */
export function PairMenu({ pid, pair }: { pid: string; pair: PairDetail["pair"] }) {
  const source = useSourceName(pid);
  const client = useQueryClient();
  const navigate = useNavigate();
  const jobs = useJobs().data?.jobs ?? [];
  const busy = jobs.some((j) => j.targetId === pair.id && ACTIVE_JOB.includes(j.status));
  const [replacing, setReplacing] = useState<Side | null>(null);

  const remove = async () => {
    if (
      !window.confirm(
        `Delete the reference pair "${pair.title}" with its two books and knowledge base? Books that used it keep their own knowledge bases.`,
      )
    )
      return;
    try {
      await del(`/api/projects/${pid}/pairs/${pair.id}`);
      await client.invalidateQueries({ queryKey: ["project", pid] });
      navigate(`/projects/${pid}`);
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't delete", message: (e as Error).message });
    }
  };

  return (
    <>
      <Menu position="bottom-end" width={340}>
        <Menu.Target>
          <Button variant="default" rightSection={<IconChevronDown size={14} />}>
            Manage
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {busy && (
            <Menu.Label>A job is running for this pair; wait for it or stop it first.</Menu.Label>
          )}
          <Menu.Label>{source} original</Menu.Label>
          <Menu.Item
            leftSection={<IconFileUpload size={15} />}
            disabled={busy}
            onClick={() => setReplacing("source")}
          >
            <Text size="sm">Replace the {source} book…</Text>
            <Text size="xs" c="dimmed" truncate maw={260}>
              {pair.sourceFileName}
            </Text>
          </Menu.Item>
          <Menu.Label>Translation</Menu.Label>
          <Menu.Item
            leftSection={<IconFileUpload size={15} />}
            disabled={busy}
            onClick={() => setReplacing("target")}
          >
            <Text size="sm">Replace the translation…</Text>
            <Text size="xs" c="dimmed" truncate maw={260}>
              {pair.targetFileName}
            </Text>
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={15} />}
            disabled={busy}
            onClick={remove}
          >
            Delete this pair…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <ReplaceModal pid={pid} pair={pair} side={replacing} onClose={() => setReplacing(null)} />
    </>
  );
}
