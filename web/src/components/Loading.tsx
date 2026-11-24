import { type MantineSpacing, Skeleton, Stack } from "@mantine/core";

// Widths in percent: a title and a line under it, varied so it reads as a list.
const ROWS: [number, number][] = [
  [38, 82],
  [52, 70],
  [31, 88],
  [45, 76],
  [36, 84],
  [49, 68],
  [41, 79],
  [34, 73],
];

/**
 * Grey rows where a list or a table is about to appear, so the page keeps
 * its shape while it loads instead of showing a spinner in the corner.
 */
export function ListLoading({ rows = 6, mt }: { rows?: number; mt?: MantineSpacing }) {
  return (
    <Stack gap="lg" mt={mt} role="status" aria-busy="true" aria-label="Loading">
      {ROWS.slice(0, rows).map(([title, line]) => (
        <Stack key={`${title}-${line}`} gap={8}>
          <Skeleton height={16} width={`${title}%`} radius="sm" />
          <Skeleton height={11} width={`${line}%`} radius="sm" />
        </Stack>
      ))}
    </Stack>
  );
}

const LINES = [96, 100, 92, 58];

function Paragraph() {
  return (
    <Stack gap={10}>
      {LINES.map((w) => (
        <Skeleton key={w} height={13} width={`${w}%`} radius="sm" />
      ))}
    </Stack>
  );
}

/** Two columns of grey paragraphs, for text that is shown side by side. */
export function TextLoading() {
  return (
    <div
      className="tr-cmp-row"
      style={{ marginTop: 24 }}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <Stack gap={28}>
        <Paragraph />
        <Paragraph />
      </Stack>
      <Stack gap={28}>
        <Paragraph />
        <Paragraph />
      </Stack>
    </div>
  );
}
