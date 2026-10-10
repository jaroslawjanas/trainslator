import { Accordion, Badge, Group, Stack, Text } from "@mantine/core";
import type { Diagnostic } from "../../../src/shared/schemas/common.ts";

export function DiagnosticsList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const warnings = diagnostics.filter((d) => d.level !== "info").length;
  return (
    <Accordion variant="contained">
      <Accordion.Item value="diag">
        <Accordion.Control>
          <Group gap="xs">
            <Text size="sm">Notes about the files</Text>
            {warnings > 0 && (
              <Badge size="sm" color="yellow" variant="light">
                {warnings} warning{warnings === 1 ? "" : "s"}
              </Badge>
            )}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap={4}>
            {diagnostics.map((d) => (
              <Text
                key={`${d.code}:${d.docIndex ?? "-"}:${d.message}`}
                size="sm"
                c={d.level === "info" ? "dimmed" : d.level === "error" ? "red" : undefined}
              >
                {d.message}
                {d.count > 1 ? ` (${d.count}×)` : ""}
              </Text>
            ))}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
