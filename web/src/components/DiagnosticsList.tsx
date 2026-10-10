import { Group, Stack, Text } from "@mantine/core";
import { IconAlertCircle, IconInfoCircle } from "@tabler/icons-react";
import type { Diagnostic } from "../../../src/shared/schemas/common.ts";

/** What the importer noticed about the EPUB files, warnings first. */
export function DiagnosticsList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const sorted = [...diagnostics].sort(
    (a, b) => Number(a.level === "info") - Number(b.level === "info"),
  );
  return (
    <Stack gap={8} maw={760}>
      {sorted.map((d) => (
        <Group
          key={`${d.code}:${d.docIndex ?? "-"}:${d.message}`}
          gap={8}
          wrap="nowrap"
          align="flex-start"
        >
          <Text
            mt={2}
            c={d.level === "error" ? "red" : d.level === "info" ? "dimmed" : "yellow"}
            style={{ display: "flex" }}
          >
            {d.level === "info" ? <IconInfoCircle size={15} /> : <IconAlertCircle size={15} />}
          </Text>
          <Text size="sm" c={d.level === "info" ? "dimmed" : undefined}>
            {d.message}
            {d.count > 1 ? ` (${d.count} times)` : ""}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
