import { Alert, Anchor, Button, Checkbox, Code, Group, List, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { JobRow, useJobs } from "../../components/JobsIndicator.tsx";
import type { BookDetail } from "./types.ts";

interface Report {
  fileName: string;
  builtAt: string;
  changedFiles: string[];
  removedFiles: string[];
  newXmlProblems: { file: string; problems: string[] }[];
  warnings: string[];
  missingGlyphs: string[];
  identifier: { old: string; new: string } | null;
  untranslatedUnits: number;
  flaggedUsed: number;
  keptSource: number;
}

export function BuildPanel({ pid, detail }: { pid: string; detail: BookDetail }) {
  const client = useQueryClient();
  const bookId = detail.book.id;
  const [useBest, setUseBest] = useState(false);
  const jobs = useJobs();
  const job = (jobs.data?.jobs ?? []).find((j) => j.targetId === bookId && j.type === "build");
  const report = useQuery({
    queryKey: ["target", bookId, "build-report", detail.book.build.builtAt],
    queryFn: () =>
      get<{ report: Report | null }>(`/api/projects/${pid}/books/${bookId}/build/report`),
  });
  const r = report.data?.report ?? null;
  const running = job && ["queued", "running", "pausing"].includes(job.status);

  return (
    <Stack maw={860}>
      <Text size="sm" c="dimmed">
        Builds the translated EPUB from the original files: translations replace the text,
        everything else (styles, images, links, footnotes) stays as it was. You can build again at
        any time after more review.
      </Text>
      <Checkbox
        label="Use best attempts for flagged units"
        description="Otherwise the build stops while units are flagged. Broken formatting is repaired or the English text is kept."
        checked={useBest}
        onChange={(e) => setUseBest(e.currentTarget.checked)}
      />
      {job && <JobRow job={job} />}
      <Group>
        <Button
          disabled={Boolean(running)}
          onClick={async () => {
            try {
              await post(`/api/projects/${pid}/books/${bookId}/build`, {
                useBestAttempts: useBest,
              });
              void client.invalidateQueries({ queryKey: ["jobs"] });
            } catch (e) {
              notifications.show({
                color: "red",
                title: "Couldn't start the build",
                message: (e as Error).message,
              });
            }
          }}
        >
          Build EPUB
        </Button>
        {detail.book.build.fileName && (
          <Anchor
            href={`/api/projects/${pid}/books/${bookId}/output`}
            download={detail.book.build.fileName}
          >
            Download {detail.book.build.fileName}
          </Anchor>
        )}
      </Group>
      {r && (
        <Stack gap="xs">
          <Text size="sm">
            Built {new Date(r.builtAt).toLocaleString()} · {r.changedFiles.length} files changed
            {r.untranslatedUnits > 0 ? ` · ${r.untranslatedUnits} unit(s) left in English` : ""}
            {r.flaggedUsed > 0 ? ` · ${r.flaggedUsed} flagged unit(s) used as best attempts` : ""}
            {r.keptSource > 0 ? ` · ${r.keptSource} flagged unit(s) kept in English` : ""}
          </Text>
          {r.identifier && (
            <Text size="sm" c="dimmed">
              New book identifier: <Code>{r.identifier.new}</Code>
            </Text>
          )}
          {r.newXmlProblems.length > 0 ? (
            <Alert color="red" title="New XML problems">
              <List size="sm">
                {r.newXmlProblems.map((p) => (
                  <List.Item key={p.file}>
                    {p.file}: {p.problems.join("; ")}
                  </List.Item>
                ))}
              </List>
            </Alert>
          ) : (
            <Text size="sm" c="green">
              All changed files are well-formed XML.
            </Text>
          )}
          {r.missingGlyphs.length > 0 && (
            <Alert color="yellow" title="Embedded fonts may lack some characters">
              The translation uses {r.missingGlyphs.join(" ")}, which never appear in the original.
              If a reader shows boxes instead, turn on "Remove embedded fonts" in the setup and
              build again.
            </Alert>
          )}
          {r.warnings.map((w) => (
            <Text key={w} size="sm" c="orange">
              {w}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
