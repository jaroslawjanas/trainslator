import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  List,
  Loader,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { get, post } from "../../api/client.ts";
import { formatDate, plural } from "../../lib/format.ts";
import { useSourceName } from "../ProjectPage.tsx";

interface Preview {
  build: { fileName: string; builtAt: string } | null;
  /** Null when it can't be told (an old build). */
  buildCurrent: boolean | null;
  untranslated: number;
  kb: { entries: number; open: number; yours: number };
  coined: { left: number; conflicts: number };
}

/** Makes a reference pair from the finished book: what it takes along, and the choices. */
export function ReferencePairModal({
  pid,
  bookId,
  opened,
  onClose,
}: {
  pid: string;
  bookId: string;
  opened: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const source = useSourceName(pid);
  const [mergeCoined, setMergeCoined] = useState(false);
  const [removeBook, setRemoveBook] = useState(false);
  const [making, setMaking] = useState(false);
  const preview = useQuery({
    queryKey: ["target", bookId, "reference-pair"],
    enabled: opened,
    queryFn: () => get<Preview>(`/api/projects/${pid}/books/${bookId}/reference-pair`),
  });
  const p = preview.data;

  const make = async () => {
    setMaking(true);
    try {
      const { pair } = await post<{ pair: { id: string } }>(
        `/api/projects/${pid}/books/${bookId}/reference-pair`,
        { mergeCoined: mergeCoined && (p?.coined.left ?? 0) > 0, removeBook },
      );
      await client.invalidateQueries({ queryKey: ["project", pid] });
      notifications.show({
        color: "green",
        message: removeBook ? "Reference pair made, and the book removed." : "Reference pair made.",
      });
      onClose();
      navigate(`/projects/${pid}/pairs/${pair.id}/kb`);
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't make the reference pair",
        message: (e as Error).message,
      });
    } finally {
      setMaking(false);
    }
  };

  const coinedLabel = p
    ? p.coined.left === 1
      ? "Also add the coined term that isn't in the knowledge base"
      : `Also add the ${p.coined.left} coined terms that aren't in the knowledge base`
    : "";

  return (
    <Modal opened={opened} onClose={onClose} title="Make a reference pair" size="lg">
      {!p ? (
        preview.error ? (
          <Alert color="red">{(preview.error as Error).message}</Alert>
        ) : (
          <Loader size="sm" />
        )
      ) : (
        <Stack>
          <Text size="sm">
            Other books in this project can then learn from this one as from a published
            translation: the pair's knowledge base goes into their reading and translating.
          </Text>
          <List size="sm" spacing={4}>
            <List.Item>Original: the {source} book this one was translated from.</List.Item>
            {p.build && (
              <List.Item>
                Translation: {p.build.fileName}, built {formatDate(p.build.builtAt)}.
              </List.Item>
            )}
            <List.Item>
              Knowledge base: {plural(p.kb.entries, "entry", "entries")}
              {p.kb.yours > 0 ? `, ${p.kb.yours} of them set or answered by you` : ""}.
            </List.Item>
          </List>
          {!p.build && (
            <Alert color="yellow">Build the EPUB first: it is the pair's translation.</Alert>
          )}
          {p.buildCurrent === false && (
            <Alert color="yellow">
              You changed the translation after the last build. Build again first if the pair should
              have your latest text.
            </Alert>
          )}
          {p.untranslated > 0 && (
            <Alert color="yellow">
              {plural(p.untranslated, "passage")} in the build {p.untranslated === 1 ? "is" : "are"}{" "}
              still in {source}.
            </Alert>
          )}
          {p.kb.open > 0 && (
            <Alert color="yellow">
              {plural(p.kb.open, "open question")} go along. Other books see{" "}
              {p.kb.open === 1 ? "it" : "them"} as open until you answer them in the pair's
              knowledge base.
            </Alert>
          )}
          {p.coined.left > 0 && (
            <Checkbox
              label={coinedLabel}
              description={
                <>
                  Only to the pair's knowledge base; this book's stays as it is.
                  {p.coined.conflicts > 0
                    ? ` ${plural(p.coined.conflicts, "of them was", "of them were")} translated two ways; the first translation is used.`
                    : ""}{" "}
                  To check them first, edit them or move them to the knowledge base under{" "}
                  <Anchor
                    component={Link}
                    to={`/projects/${pid}/books/${bookId}/translate?view=glossary`}
                    size="xs"
                    onClick={onClose}
                  >
                    Coined terms
                  </Anchor>
                  .
                </>
              }
              checked={mergeCoined}
              onChange={(e) => setMergeCoined(e.currentTarget.checked)}
            />
          )}
          <Checkbox
            label="Remove this book afterwards"
            description="Deletes the book with its translation history, Review and earlier builds. The pair keeps the original, the build and the knowledge base."
            checked={removeBook}
            onChange={(e) => setRemoveBook(e.currentTarget.checked)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={making} disabled={!p.build} onClick={make}>
              Make the reference pair
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
