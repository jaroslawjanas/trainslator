import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Checkbox,
  Group,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowDown, IconArrowUp, IconChevronDown, IconDots } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Alignment, AlignUnit } from "../../../../src/shared/schemas/alignment.ts";
import type { EpubStructure, Segment } from "../../../../src/shared/schemas/epub.ts";
import { del, get, post, put } from "../../api/client.ts";
import { DiagnosticsList } from "../../components/DiagnosticsList.tsx";
import { Section } from "../../components/PageHeader.tsx";
import { StageMark } from "../../components/StageMark.tsx";
import { displayTitle } from "../../lib/format.ts";
import { useSourceName } from "../ProjectPage.tsx";
import {
  mergeWithNext,
  moveFirstToPrevious,
  moveLastToNext,
  setInclude,
  splitLast,
  unlink,
} from "./alignOps.ts";

export interface PairDetail {
  pair: {
    id: string;
    title: string;
    sourceFileName: string;
    targetFileName: string;
    phase1: { state: string; finishedAt: string | null; entries: number | null };
    /** Set when the pair was made from a finished book. */
    fromBook: { bookId: string; title: string; madeAt: string } | null;
  };
  source: EpubStructure;
  target: EpubStructure;
  alignment: Alignment;
  ratio: number;
}

interface Preview {
  source: { titles: string[]; words: number; start: string; end: string; truncated: boolean };
  target: { titles: string[]; words: number; start: string; end: string; truncated: boolean };
}

function segmentsAt(structure: EpubStructure, depth: number): Segment[] {
  return structure.segmentsByDepth[String(Math.max(1, Math.min(structure.maxDepth, depth)))] ?? [];
}

function SegmentList({
  ids,
  segments,
  canUp,
  canDown,
  onUp,
  onDown,
}: {
  ids: string[];
  segments: Map<string, Segment>;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  if (ids.length === 0) {
    return (
      <Text size="sm" c="dimmed" fs="italic">
        nothing on this side
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      {ids.map((id, k) => {
        const s = segments.get(id);
        return (
          <Group key={id} gap={4} wrap="nowrap">
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text
                size="md"
                lineClamp={1}
                className="serif"
                c={s?.guess === "body" ? undefined : "dimmed"}
              >
                {s ? displayTitle(s.title) : id}
              </Text>
              <Text size="xs" c="dimmed" className="num">
                {s?.words.toLocaleString() ?? "?"} words
                {s && s.guess !== "body" ? `, ${s.guess} matter` : ""}
              </Text>
            </Box>
            {k === 0 && canUp && (
              <Tooltip label="Move to the previous row">
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={onUp}
                  aria-label="Move to previous row"
                >
                  <IconArrowUp size={13} />
                </ActionIcon>
              </Tooltip>
            )}
            {k === ids.length - 1 && canDown && (
              <Tooltip label="Move to the next row">
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={onDown}
                  aria-label="Move to next row"
                >
                  <IconArrowDown size={13} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        );
      })}
    </Stack>
  );
}

function PreviewModal({
  pid,
  pairId,
  unitId,
  onClose,
}: {
  pid: string;
  pairId: string;
  unitId: string | null;
  onClose: () => void;
}) {
  const source = useSourceName(pid);
  const { data, isLoading, error } = useQuery({
    queryKey: ["preview", pairId, unitId],
    queryFn: () => get<Preview>(`/api/projects/${pid}/pairs/${pairId}/units/${unitId}/preview`),
    enabled: unitId !== null,
  });
  const side = (title: string, p: Preview["source"]) => (
    <Stack gap="xs">
      <Text fw={600}>{title}</Text>
      <Text size="xs" c="dimmed">
        {p.titles.map(displayTitle).join(" + ") || "nothing on this side"},{" "}
        {p.words.toLocaleString()} words
      </Text>
      <Paper withBorder p="sm">
        <ScrollArea h={260}>
          <Text size="md" className="serif" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
            {p.start}
          </Text>
        </ScrollArea>
      </Paper>
      {p.end && (
        <>
          <Text size="xs" c="dimmed">
            {p.truncated ? "… end:" : "continued:"}
          </Text>
          <Paper withBorder p="sm">
            <ScrollArea h={160}>
              <Text size="md" className="serif" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                {p.end}
              </Text>
            </ScrollArea>
          </Paper>
        </>
      )}
    </Stack>
  );
  return (
    <Modal opened={unitId !== null} onClose={onClose} title="Compare the two sides" size="90%">
      {isLoading && <Text>Loading…</Text>}
      {error && <Alert color="red">{(error as Error).message}</Alert>}
      {data && (
        <SimpleGrid cols={2}>
          {side(source, data.source)}
          {side("Translation", data.target)}
        </SimpleGrid>
      )}
    </Modal>
  );
}

export function AlignmentPanel({ pid, detail }: { pid: string; detail: PairDetail }) {
  const source = useSourceName(pid);
  const client = useQueryClient();
  const navigate = useNavigate();
  const diagnostics = [...detail.source.diagnostics, ...detail.target.diagnostics];
  const [units, setUnits] = useState<AlignUnit[]>(detail.alignment.units);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => setUnits(detail.alignment.units), [detail.alignment]);

  const al = detail.alignment;
  const sourceSegs = useMemo(
    () => new Map(segmentsAt(detail.source, al.tocDepthSource).map((s) => [s.id, s])),
    [detail.source, al.tocDepthSource],
  );
  const targetSegs = useMemo(
    () => new Map(segmentsAt(detail.target, al.tocDepthTarget).map((s) => [s.id, s])),
    [detail.target, al.tocDepthTarget],
  );
  const dirty = JSON.stringify(units) !== JSON.stringify(al.units);
  const words = (ids: string[], map: Map<string, Segment>) =>
    ids.reduce((s, id) => s + (map.get(id)?.words ?? 0), 0);
  const included = units.filter((u) => u.include);

  const save = async (status: Alignment["status"]) => {
    setSaving(true);
    try {
      await put(`/api/projects/${pid}/pairs/${detail.pair.id}/alignment`, { ...al, units, status });
      await client.invalidateQueries({ queryKey: ["pair", detail.pair.id] });
      notifications.show({
        color: "green",
        message: status === "confirmed" ? "Alignment confirmed." : "Alignment saved.",
      });
    } catch (e) {
      notifications.show({ color: "red", title: "Couldn't save", message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const repropose = async (source: number, target: number, withAi = false) => {
    if (dirty && !window.confirm("Discard your changes and propose a new alignment?")) return;
    if (withAi) setAsking(true);
    try {
      await post(
        `/api/projects/${pid}/pairs/${detail.pair.id}/alignment/${withAi ? "propose-ai" : "propose"}`,
        { source, target },
      );
      await client.invalidateQueries({ queryKey: ["pair", detail.pair.id] });
    } catch (e) {
      notifications.show({
        color: "red",
        title: "Couldn't propose",
        message: (e as Error).message,
      });
    } finally {
      setAsking(false);
    }
  };

  const depthOptions = (max: number) =>
    Array.from({ length: max }, (_, i) => ({
      value: String(i + 1),
      label: i + 1 === 1 ? "Top level" : `Down to level ${i + 1}`,
    }));

  const statusText =
    al.status === "confirmed" && !dirty
      ? "Confirmed"
      : dirty
        ? "Unsaved changes"
        : "Not confirmed yet";

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" gap="md">
        <Group align="flex-end" gap="sm">
          <Select
            label={`${source} chapters`}
            w={190}
            data={depthOptions(detail.source.maxDepth)}
            value={String(al.tocDepthSource)}
            allowDeselect={false}
            onChange={(v) => v && repropose(Number(v), al.tocDepthTarget)}
          />
          <Select
            label="Translated chapters"
            w={190}
            data={depthOptions(detail.target.maxDepth)}
            value={String(al.tocDepthTarget)}
            allowDeselect={false}
            onChange={(v) => v && repropose(al.tocDepthSource, Number(v))}
          />
          <Menu position="bottom-start" width={320}>
            <Menu.Target>
              <Button
                variant="default"
                loading={asking}
                rightSection={<IconChevronDown size={14} />}
              >
                Propose again
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => repropose(al.tocDepthSource, al.tocDepthTarget)}>
                <Text size="sm">By chapter length</Text>
                <Text size="xs" c="dimmed">
                  Instant, no AI. Works when both books have the same contents.
                </Text>
              </Menu.Item>
              <Menu.Item onClick={() => repropose(al.tocDepthSource, al.tocDepthTarget, true)}>
                <Text size="sm">With AI</Text>
                <Text size="xs" c="dimmed">
                  Matches titles and opening lines. Better when the books differ (extra stories,
                  notes, a licence). One short request.
                </Text>
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
        <Group gap="xs">
          <Group gap={6} mr="xs">
            <StageMark state={al.status === "confirmed" && !dirty ? "done" : "none"} />
            <Text size="sm" c={al.status === "confirmed" && !dirty ? undefined : "dimmed"}>
              {statusText}
            </Text>
          </Group>
          {dirty && (
            <>
              <Button variant="subtle" color="gray" onClick={() => setUnits(al.units)}>
                Undo
              </Button>
              <Button
                variant="default"
                loading={saving}
                onClick={() => save(al.status === "confirmed" ? "confirmed" : "proposed")}
              >
                Save
              </Button>
            </>
          )}
          {(dirty || al.status !== "confirmed") && (
            <Button
              loading={saving}
              disabled={included.length === 0}
              onClick={() => save("confirmed")}
            >
              Confirm alignment
            </Button>
          )}
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        {included.length} of {units.length} rows are used for learning. The translation is about{" "}
        {detail.ratio.toFixed(2)} times as long as the {source}; the length column compares each row
        with that.
      </Text>
      <Table highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={44}>Use</Table.Th>
            <Table.Th>{source}</Table.Th>
            <Table.Th>Translation</Table.Th>
            <Table.Th w={110}>Length</Table.Th>
            <Table.Th w={60} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {units.map((u, i) => {
            const wa = words(u.source, sourceSegs);
            const wb = words(u.target, targetSegs);
            const rel = wa > 0 && wb > 0 ? wb / detail.ratio / wa : null;
            const color =
              rel === null
                ? "dimmed"
                : rel > 0.75 && rel < 1.33
                  ? undefined
                  : rel > 0.5 && rel < 2
                    ? "yellow"
                    : "red";
            return (
              <Table.Tr key={u.id} opacity={u.include ? 1 : 0.6}>
                <Table.Td>
                  <Checkbox
                    checked={u.include}
                    onChange={(e) => setUnits(setInclude(units, i, e.currentTarget.checked))}
                    aria-label="Include"
                  />
                </Table.Td>
                <Table.Td>
                  <SegmentList
                    ids={u.source}
                    segments={sourceSegs}
                    canUp={i > 0}
                    canDown
                    onUp={() => setUnits(moveFirstToPrevious(units, i, "source"))}
                    onDown={() => setUnits(moveLastToNext(units, i, "source"))}
                  />
                </Table.Td>
                <Table.Td>
                  <SegmentList
                    ids={u.target}
                    segments={targetSegs}
                    canUp={i > 0}
                    canDown
                    onUp={() => setUnits(moveFirstToPrevious(units, i, "target"))}
                    onDown={() => setUnits(moveLastToNext(units, i, "target"))}
                  />
                </Table.Td>
                <Table.Td>
                  <UnstyledButton onClick={() => setPreview(u.id)} aria-label="Compare the text">
                    <Text
                      size="sm"
                      c={color}
                      className="num"
                      td="underline"
                      style={{
                        textDecorationColor: "var(--tr-rule-strong)",
                        textUnderlineOffset: 3,
                      }}
                    >
                      {rel === null ? "one side" : `${Math.round(rel * 100)}%`}
                    </Text>
                  </UnstyledButton>
                  {u.confidence !== null && (
                    <Text size="xs" c="dimmed">
                      {Math.round(u.confidence * 100)}% sure
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon variant="subtle" color="gray" aria-label="Row actions">
                        <IconDots size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => setPreview(u.id)}>Compare text</Menu.Item>
                      <Menu.Item
                        disabled={i + 1 >= units.length}
                        onClick={() => setUnits(mergeWithNext(units, i))}
                      >
                        Merge with next row
                      </Menu.Item>
                      <Menu.Item
                        disabled={u.source.length < 2 && u.target.length < 2}
                        onClick={() => setUnits(splitLast(units, i))}
                      >
                        Split off the last chapter
                      </Menu.Item>
                      <Menu.Item
                        disabled={u.source.length === 0 || u.target.length === 0}
                        onClick={() => setUnits(unlink(units, i))}
                      >
                        Unlink the two sides
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      <PreviewModal
        pid={pid}
        pairId={detail.pair.id}
        unitId={preview}
        onClose={() => setPreview(null)}
      />
      <Box mt={48}>
        {diagnostics.length > 0 && (
          <Section title="Notes about the files">
            <DiagnosticsList diagnostics={diagnostics} />
          </Section>
        )}
        <Section
          title="Delete this pair"
          description="Deletes the two books and what was learned from them. Books that used this pair keep their own knowledge bases."
        >
          <Button
            color="red"
            variant="outline"
            onClick={async () => {
              if (!window.confirm("Delete this reference pair and its knowledge base?")) return;
              try {
                await del(`/api/projects/${pid}/pairs/${detail.pair.id}`);
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
            Delete pair
          </Button>
        </Section>
      </Box>
    </Stack>
  );
}
