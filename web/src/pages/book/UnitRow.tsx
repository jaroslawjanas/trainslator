import {
  ActionIcon,
  Button,
  Group,
  Popover,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowBackUp, IconCheck, IconPencil, IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import { del, post, put } from "../../api/client.ts";
import { UnitText } from "../../components/PlaceholderText.tsx";
import type { UnitView } from "./types.ts";

type Mark = "attention" | "warning" | "edited" | null;

export function unitMark(unit: UnitView): Mark {
  if (unit.status === "flagged" || unit.status === "refused") return "attention";
  if (unit.status === "edited") return "edited";
  if (unit.warnings.length > 0) return "warning";
  return null;
}

const PLACEHOLDER_NAMES: Record<string, string> = {
  i: "italic",
  em: "emphasis",
  b: "bold",
  strong: "bold",
  a: "link",
  br: "line break",
  newline: "line break",
  sup: "superscript",
  sub: "subscript",
  img: "image",
};

/** One row of the open book: English on the verso, the translation on the recto. */
export function UnitRow({
  pid,
  bookId,
  unit,
  showTags,
  onChanged,
}: {
  pid: string;
  bookId: string;
  unit: UnitView;
  showTags: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(unit.translation ?? "");
  const [instruction, setInstruction] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${pid}/books/${bookId}/units/${unit.urlKey}`;
  const mark = unitMark(unit);

  const call = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      notifications.show({ color: "green", message });
      onChanged();
      return true;
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't do that",
        message: (e as Error).message,
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const required = unit.placeholders.filter((p) => p.required);

  return (
    <div className="tr-spread-row" data-role={unit.role} data-mark={mark ?? undefined}>
      <div className="tr-verso">
        <UnitText text={unit.source} placeholders={unit.placeholders} showTags={showTags} />
      </div>
      <div className="tr-gutter" />
      <div className="tr-recto">
        {editing ? (
          <Stack gap={8}>
            <Textarea
              aria-label="Translation"
              autosize
              minRows={2}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              styles={{
                input: { fontFamily: "var(--tr-serif)", fontSize: 16, lineHeight: 1.55 },
              }}
              data-autofocus
            />
            {required.length > 0 && (
              <Text size="xs" c="dimmed">
                Keep the formatting tags:{" "}
                {required
                  .map(
                    (p) =>
                      `${p.kind === "g" ? `<g${p.n}>…</g${p.n}>` : `<x${p.n}/>`} (${PLACEHOLDER_NAMES[p.label] ?? p.label})`,
                  )
                  .join(", ")}
                .
              </Text>
            )}
            <Group gap="xs">
              <Button
                size="xs"
                loading={busy}
                onClick={async () =>
                  (await call(() => put(base, { text }), "Translation saved.")) && setEditing(false)
                }
              >
                Save
              </Button>
              <Button size="xs" variant="default" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </Group>
          </Stack>
        ) : unit.translation ? (
          <UnitText text={unit.translation} placeholders={unit.placeholders} showTags={showTags} />
        ) : (
          <div className="tr-page-text tr-pending">
            {unit.status === "refused" ? "The model refused this passage." : "Not translated yet."}
          </div>
        )}
        {!editing && (
          <>
            {unit.errors.map((e) => (
              <div key={e} className="tr-note" data-kind="attention">
                {e}
              </div>
            ))}
            {unit.warnings.map((w) => (
              <div key={w} className="tr-note" data-kind="warning">
                {w}
              </div>
            ))}
            {unit.status === "edited" && (
              <div className="tr-note" data-kind="edited">
                Edited by you.
              </div>
            )}
            {unit.instruction && unit.status !== "edited" && (
              <div className="tr-note" data-kind="edited">
                Re-translated with the instruction "{unit.instruction}".
              </div>
            )}
          </>
        )}
      </div>
      <div className="tr-margin">
        {!editing && (
          <div className="tr-row-actions" data-open={asking || undefined}>
            <Tooltip label="Edit the translation" position="left">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Edit the translation"
                onClick={() => {
                  setText(unit.translation ?? "");
                  setEditing(true);
                }}
              >
                <IconPencil size={15} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
            <Popover
              opened={asking}
              onChange={setAsking}
              position="left-start"
              width={340}
              trapFocus
              withArrow
            >
              <Popover.Target>
                <Tooltip label="Translate again" position="left" disabled={asking}>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label="Translate again"
                    onClick={() => setAsking((v) => !v)}
                  >
                    <IconRefresh size={15} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Text size="sm" fw={500}>
                    Translate this passage again
                  </Text>
                  <TextInput
                    size="xs"
                    placeholder="Optional instruction, e.g. more formal"
                    value={instruction}
                    onChange={(e) => setInstruction(e.currentTarget.value)}
                    data-autofocus
                  />
                  <Group justify="flex-end" gap="xs">
                    <Button size="xs" variant="default" onClick={() => setAsking(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      loading={busy}
                      onClick={async () => {
                        if (
                          await call(
                            () => post(`${base}/retranslate`, { instruction: instruction || null }),
                            "Translating again.",
                          )
                        )
                          setAsking(false);
                      }}
                    >
                      Translate again
                    </Button>
                  </Group>
                </Stack>
              </Popover.Dropdown>
            </Popover>
            {unit.status === "flagged" && unit.translation && unit.errors.length === 0 && (
              <Tooltip label="Accept as it is" position="left">
                <ActionIcon
                  variant="subtle"
                  color="bookcloth"
                  size="sm"
                  aria-label="Accept as it is"
                  onClick={() => call(() => post(`${base}/accept`), "Accepted.")}
                >
                  <IconCheck size={15} stroke={1.9} />
                </ActionIcon>
              </Tooltip>
            )}
            {unit.status === "edited" && (
              <Tooltip label="Go back to the AI translation" position="left">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label="Go back to the AI translation"
                  onClick={() => call(() => del(`${base}/edit`), "Back to the AI translation.")}
                >
                  <IconArrowBackUp size={15} stroke={1.7} />
                </ActionIcon>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
