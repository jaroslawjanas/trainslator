import {
  Alert,
  Anchor,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  List,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertCircle, IconCheck, IconDownload } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { get, post } from "../../api/client.ts";
import { useJobs } from "../../components/JobsIndicator.tsx";
import { Section } from "../../components/PageHeader.tsx";
import { RunPanel } from "../../components/RunPanel.tsx";
import { formatDate, plural } from "../../lib/format.ts";
import { useSourceName } from "../ProjectPage.tsx";
import { ReferencePairModal } from "./ReferencePairModal.tsx";
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

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <Group gap={8} wrap="nowrap" align="flex-start">
      <Box mt={3} c={ok ? "var(--tr-bookcloth)" : "var(--tr-ochre)"}>
        {ok ? <IconCheck size={15} stroke={2.2} /> : <IconAlertCircle size={15} stroke={2} />}
      </Box>
      <Text size="md">{children}</Text>
    </Group>
  );
}

export function BuildPanel({ pid, detail }: { pid: string; detail: BookDetail }) {
  const source = useSourceName(pid);
  const client = useQueryClient();
  const bookId = detail.book.id;
  const [useBest, setUseBest] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const jobs = useJobs();
  const job = (jobs.data?.jobs ?? []).find((j) => j.targetId === bookId && j.type === "build");
  const report = useQuery({
    queryKey: ["target", bookId, "build-report", detail.book.build.builtAt],
    queryFn: () =>
      get<{ report: Report | null }>(`/api/projects/${pid}/books/${bookId}/build/report`),
  });
  const r = report.data?.report ?? null;
  const built = Boolean(detail.book.build.builtAt);

  return (
    <>
      <RunPanel
        state={built ? "done" : "none"}
        finishedAt={detail.book.build.builtAt}
        job={job}
        summary={
          built && detail.book.build.fileName ? (
            <>
              Saved as {detail.book.build.fileName}. Every build is kept in{" "}
              <Anchor component={Link} to={`/projects/${pid}/books/${bookId}/history`} size="sm">
                History
              </Anchor>
              .
            </>
          ) : undefined
        }
        actionLabel={built ? "Build again" : "Build the EPUB"}
        onRun={async () => {
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
        extra={
          detail.book.build.fileName && (
            <Button
              component="a"
              href={`/api/projects/${pid}/books/${bookId}/output`}
              download={detail.book.build.fileName}
              leftSection={<IconDownload size={16} stroke={1.8} />}
            >
              Download
            </Button>
          )
        }
      >
        <Box mt="md" pl={22}>
          <Checkbox
            label="Use the best attempts for passages that still need attention"
            description={`Otherwise the build stops while any passage needs attention. Broken formatting is repaired, or the ${source} is kept.`}
            checked={useBest}
            onChange={(e) => setUseBest(e.currentTarget.checked)}
          />
        </Box>
      </RunPanel>

      {r && (
        <Section title="Last build" description={`Built ${formatDate(r.builtAt)}.`}>
          <Stack gap={8} maw={760}>
            {r.newXmlProblems.length === 0 ? (
              <Check ok>
                All {plural(r.changedFiles.length, "changed file")} are well-formed XML.
              </Check>
            ) : (
              <Alert color="red" title="New XML problems">
                <List size="sm">
                  {r.newXmlProblems.map((p) => (
                    <List.Item key={p.file}>
                      {p.file}: {p.problems.join("; ")}
                    </List.Item>
                  ))}
                </List>
              </Alert>
            )}
            <Check ok={r.untranslatedUnits === 0}>
              {r.untranslatedUnits === 0
                ? "Every passage is translated."
                : `${plural(r.untranslatedUnits, "passage")} left in ${source}.`}
            </Check>
            {r.flaggedUsed > 0 && (
              <Check ok={false}>
                {plural(r.flaggedUsed, "passage")} that needed attention used as best attempts.
              </Check>
            )}
            {r.keptSource > 0 && (
              <Check ok={false}>
                {plural(r.keptSource, "passage")} that needed attention kept in {source}.
              </Check>
            )}
            {r.identifier && (
              <Check ok>
                New book identifier <Code>{r.identifier.new}</Code>, so reading apps don't confuse
                it with the original.
              </Check>
            )}
            {r.missingGlyphs.length > 0 && (
              <Alert color="yellow" title="The embedded fonts may lack some characters">
                The translation uses {r.missingGlyphs.join(" ")}, which never appear in the
                original. If a reader shows boxes instead, turn on "Remove embedded fonts" in the
                setup and build again.
              </Alert>
            )}
            {r.warnings.map((w) => (
              <Text key={w} size="sm" c="yellow">
                {w}
              </Text>
            ))}
          </Stack>
        </Section>
      )}

      {built && (
        <Section
          title="Use as a reference pair"
          description="When the book is finished, other books in this project can learn from it as from a published translation."
        >
          <Stack gap="sm" maw={760}>
            <Text size="sm">
              The pair gets the original, this build as the translation, and the book's knowledge
              base. The book itself stays as it is unless you choose to remove it.
            </Text>
            <Group>
              <Button variant="default" onClick={() => setPairOpen(true)}>
                Make a reference pair…
              </Button>
            </Group>
          </Stack>
        </Section>
      )}
      <ReferencePairModal
        pid={pid}
        bookId={bookId}
        opened={pairOpen}
        onClose={() => setPairOpen(false)}
      />
    </>
  );
}
