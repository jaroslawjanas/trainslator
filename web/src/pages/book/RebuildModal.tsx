import { Button, Checkbox, Group, Modal, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { get } from "../../api/client.ts";
import { listText, plural } from "../../lib/format.ts";

interface OwnChanges {
  entries: number;
  deletions: number;
  styleRules: number;
}

/** "Read the whole book again": what happens, and whether your own changes stay. */
export function RebuildModal({
  pid,
  bookId,
  opened,
  costText,
  onClose,
  onConfirm,
}: {
  pid: string;
  bookId: string;
  opened: boolean;
  /** The estimate for reading the book, when known. */
  costText: string | null;
  onClose: () => void;
  onConfirm: (dropOwn: boolean) => Promise<void>;
}) {
  const [dropOwn, setDropOwn] = useState(false);
  const [starting, setStarting] = useState(false);
  const own = useQuery({
    queryKey: ["target", bookId, "own-changes"],
    enabled: opened,
    queryFn: () => get<OwnChanges>(`/api/projects/${pid}/books/${bookId}/phase2/own-changes`),
  });
  const counts = own.data
    ? [
        own.data.entries > 0
          ? `${plural(own.data.entries, "entry", "entries")} you set or answered`
          : null,
        own.data.deletions > 0
          ? plural(own.data.deletions, "deleted entry", "deleted entries")
          : null,
        own.data.styleRules > 0 ? `${plural(own.data.styleRules, "style rule")} you wrote` : null,
      ].filter((x): x is string => x !== null)
    : [];
  return (
    <Modal opened={opened} onClose={onClose} title="Read the whole book again" size="lg">
      <Stack>
        <Text size="sm">
          Every chapter is read again from an empty knowledge base, and the models are asked anew
          instead of repeating their earlier answers.{costText ? ` ${costText}` : ""}
        </Text>
        <Text size="sm">
          The current knowledge base is saved in History first, so you can restore it if the new one
          comes out worse. Your translation isn't changed; translate again to use the new knowledge
          base.
        </Text>
        <Checkbox
          label="Also drop my own changes"
          description={
            counts.length > 0
              ? `Kept unless you tick this: ${listText(counts)}. The saved copy has them either way.`
              : "You haven't changed anything in this knowledge base."
          }
          disabled={counts.length === 0}
          checked={dropOwn}
          onChange={(e) => setDropOwn(e.currentTarget.checked)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={starting}
            onClick={async () => {
              setStarting(true);
              try {
                await onConfirm(dropOwn);
                onClose();
              } finally {
                setStarting(false);
              }
            }}
          >
            Read the whole book again
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
