import {
  ActionIcon,
  Alert,
  Badge,
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
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Alignment, AlignUnit } from "../../../../src/shared/schemas/alignment.ts";
import type { EpubStructure, Segment } from "../../../../src/shared/schemas/epub.ts";
import { get, post, put } from "../../api/client.ts";
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
    phase1: { state: string; entries: number | null };
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
        (nothing)
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      {ids.map((id, k) => {
        const s = segments.get(id);
        return (
          <Group key={id} gap={4} wrap="nowrap">
            <Text
              size="sm"
              lineClamp={1}
              style={{ flex: 1 }}
              c={s?.guess === "body" ? undefined : "dimmed"}
            >
              {s?.title ?? id}
              <Text span size="xs" c="dimmed">
                {" "}
                · {s?.words.toLocaleString() ?? "?"} words
                {s && s.guess !== "body" ? ` · ${s.guess}` : ""}
              </Text>
            </Text>
            {k === 0 && canUp && (
              <Tooltip label="Move to the previous row">
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  onClick={onUp}
                  aria-label="Move to previous row"
                >
                  ↑
                </ActionIcon>
              </Tooltip>
            )}
            {k === ids.length - 1 && canDown && (
              <Tooltip label="Move to the next row">
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  onClick={onDown}
                  aria-label="Move to next row"
                >
                  ↓
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
  const { data, isLoading, error } = useQuery({
    queryKey: ["preview", pairId, unitId],
    queryFn: () => get<Preview>(`/api/projects/${pid}/pairs/${pairId}/units/${unitId}/preview`),
    enabled: unitId !== null,
  });
  const side = (title: string, p: Preview["source"]) => (
    <Stack gap="xs">
      <Text fw={600}>{title}</Text>
      <Text size="xs" c="dimmed">
        {p.titles.join(" + ") || "(nothing)"} · {p.words.toLocaleString()} words
      </Text>
      <Paper withBorder p="sm">
        <ScrollArea h={260}>
          <Text size="sm" className="unit-text">
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
              <Text size="sm" className="unit-text">
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
          {side("English", data.source)}
          {side("Translation", data.target)}
        </SimpleGrid>
      )}
    </Modal>
  );
}

export function AlignmentPanel({ pid, detail }: { pid: string; detail: PairDetail }) {
  const client = useQueryClient();
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

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Each row pairs a chapter of the English book with the matching chapter of the translation.
        Check the rows, fix them with the arrows and the row menu, untick what phase 1 should skip
        (front matter, notes …), then confirm. Click a row's words to compare the text.
      </Text>
      <Group justify="space-between" align="flex-end">
        <Group align="flex-end">
          <Select
            label="English chapters from TOC"
            data={depthOptions(detail.source.maxDepth)}
            value={String(al.tocDepthSource)}
            allowDeselect={false}
            onChange={(v) => v && repropose(Number(v), al.tocDepthTarget)}
          />
          <Select
            label="Translation chapters from TOC"
            data={depthOptions(detail.target.maxDepth)}
            value={String(al.tocDepthTarget)}
            allowDeselect={false}
            onChange={(v) => v && repropose(al.tocDepthSource, Number(v))}
          />
          <Button variant="subtle" onClick={() => repropose(al.tocDepthSource, al.tocDepthTarget)}>
            Propose again
          </Button>
          <Tooltip
            multiline
            w={300}
            label="Asks the utility model to match the chapters by their titles, opening words and lengths. Useful when the books differ in content (extra stories, notes, a licence). One short request."
          >
            <Button
              variant="light"
              loading={asking}
              onClick={() => repropose(al.tocDepthSource, al.tocDepthTarget, true)}
            >
              Propose with AI
            </Button>
          </Tooltip>
        </Group>
        <Group>
          <Badge
            color={al.status === "confirmed" && !dirty ? "green" : "yellow"}
            variant="light"
            size="lg"
          >
            {al.status === "confirmed" && !dirty
              ? "confirmed"
              : dirty
                ? "unsaved changes"
                : "not confirmed"}
          </Badge>
          <Button variant="default" disabled={!dirty} onClick={() => setUnits(al.units)}>
            Undo
          </Button>
          <Button
            variant="light"
            disabled={!dirty}
            loading={saving}
            onClick={() => save(al.status === "confirmed" ? "confirmed" : "proposed")}
          >
            Save
          </Button>
          <Button
            loading={saving}
            disabled={included.length === 0}
            onClick={() => save("confirmed")}
          >
            Confirm alignment
          </Button>
        </Group>
      </Group>
      <Text size="sm">
        {included.length} of {units.length} rows included · length ratio of the translation:{" "}
        {detail.ratio.toFixed(2)}×
      </Text>
      <Table striped highlightOnHover verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={40}>Use</Table.Th>
            <Table.Th>English</Table.Th>
            <Table.Th>Translation</Table.Th>
            <Table.Th w={110}>Length match</Table.Th>
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
                ? "gray"
                : rel > 0.75 && rel < 1.33
                  ? "green"
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
                  <Tooltip label="Compare the text" withArrow>
                    <Badge
                      color={color}
                      variant="light"
                      style={{ cursor: "pointer" }}
                      onClick={() => setPreview(u.id)}
                    >
                      {rel === null ? "one side" : `${Math.round(rel * 100)}%`}
                    </Badge>
                  </Tooltip>
                  {u.confidence !== null && (
                    <Text size="xs" c="dimmed">
                      confidence {Math.round(u.confidence * 100)}%
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon variant="subtle" aria-label="Row actions">
                        ⋯
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
    </Stack>
  );
}
