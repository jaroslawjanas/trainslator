import {
  ActionIcon,
  Group,
  List,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconQuestionMark } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TranslationMode } from "../../../../src/shared/schemas/project.ts";
import { patch } from "../../api/client.ts";

const MODES: { value: TranslationMode; label: string }[] = [
  { value: "chunks", label: "Chunks" },
  { value: "chapters", label: "Whole chapters" },
];

/** Chunks or whole chapters for phase 3, with a "?" that explains the difference. */
export function TranslationModeChoice({
  pid,
  bookId,
  mode,
  disabled,
}: {
  pid: string;
  bookId: string;
  mode: TranslationMode;
  disabled: boolean;
}) {
  const client = useQueryClient();
  const [help, setHelp] = useState(false);
  const save = async (value: string) => {
    try {
      await patch(`/api/projects/${pid}/books/${bookId}`, { translationMode: value });
      await client.invalidateQueries({ queryKey: ["book", bookId] });
      await client.invalidateQueries({ queryKey: ["target", bookId] });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't switch", message: (e as Error).message });
    }
  };
  return (
    <Group gap="xs" mt="sm" pl={22} wrap="nowrap">
      <Text size="sm" c="dimmed">
        Translate in
      </Text>
      <SegmentedControl
        size="xs"
        value={mode}
        onChange={save}
        disabled={disabled}
        data={MODES}
        aria-label="How to send the book to the model"
      />
      <ActionIcon
        variant="default"
        radius="xl"
        size="sm"
        aria-label="How chunks and whole chapters differ"
        onClick={() => setHelp(true)}
      >
        <IconQuestionMark size={13} stroke={2.4} />
      </ActionIcon>
      <ModeHelp opened={help} onClose={() => setHelp(false)} />
    </Group>
  );
}

function Side({
  title,
  how,
  better,
  worse,
}: {
  title: string;
  how: string;
  better: string[];
  worse: string[];
}) {
  return (
    <Stack gap="xs">
      <Title order={4}>{title}</Title>
      <Text size="sm">{how}</Text>
      <Text size="sm" fw={600} mt={4}>
        Better
      </Text>
      <List size="sm" spacing={4}>
        {better.map((t) => (
          <List.Item key={t}>{t}</List.Item>
        ))}
      </List>
      <Text size="sm" fw={600} mt={4}>
        Worse
      </Text>
      <List size="sm" spacing={4}>
        {worse.map((t) => (
          <List.Item key={t}>{t}</List.Item>
        ))}
      </List>
    </Stack>
  );
}

function ModeHelp({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title="Chunks or whole chapters" size="xl">
      <Stack gap="lg">
        <Text size="sm">
          Both use the same instructions, knowledge bases and checks. They differ in how much of the
          book the model sees while it translates. With a strong model, whole chapters usually give
          a more consistent translation. Chunks are the safer choice for smaller models.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xl">
          <Side
            title="Chunks"
            how="Each chapter is cut into chunks of up to about 1,700 words, translated one after another. Each chunk also gets the last 3 paragraphs before it, with their translation."
            better={[
              "Short answers: models stay careful to the end and rarely drop a sentence.",
              "Works with models that can only write short answers.",
              "A failed answer is quick and cheap to redo.",
            ]}
            worse={[
              "The model sees only a few paragraphs before the chunk and nothing after it, so it can miss who is speaking or who “she” is.",
              "Word choices and tone can drift from one chunk to the next.",
            ]}
          />
          <Side
            title="Whole chapters"
            how="Each chapter is translated in one request, together with phase 2's summaries of the chapters before it. A chapter over about 5,000 words is split into a few parts. Each part sees the chapter's text and the translation so far."
            better={[
              "The model sees the whole chapter, so speakers, pronouns, tone and word choices stay consistent.",
              "It knows the story so far, not just this chapter.",
              "Fewer requests.",
            ]}
            worse={[
              "Long answers: some models condense or skip sentences near the end. A missing paragraph is caught; a sentence missing inside a paragraph is not.",
              "Needs a model that can write long answers, up to about 15,000 tokens plus its reasoning. An answer cut off at the limit is retried in halves, which costs more.",
              "Each request takes minutes, so progress moves in big steps, and a failed answer costs more to redo.",
            ]}
          />
        </SimpleGrid>
        <Text size="sm" c="dimmed">
          The cost is about the same: most of it is the translated text. Long chapters cost a little
          more as whole chapters, because each part sends the chapter again. You can switch between
          runs. Translated chapters and your own edits are kept; a chapter that's only partly
          translated, or has passages that need attention, is translated again.
        </Text>
      </Stack>
    </Modal>
  );
}
