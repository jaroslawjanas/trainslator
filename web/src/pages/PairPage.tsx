import { Alert } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router";
import { get } from "../api/client.ts";
import { ListLoading } from "../components/Loading.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { displayTitle } from "../lib/format.ts";
import { defaultPairStage, PAIR_STAGES } from "../lib/stages.ts";
import { KbEditor } from "./kb/KbEditor.tsx";
import { useSourceName } from "./ProjectPage.tsx";
import { AlignmentPanel, type PairDetail } from "./pair/AlignmentPanel.tsx";
import { PairMenu } from "./pair/PairMenu.tsx";
import { Phase1Panel } from "./pair/Phase1Panel.tsx";

export function PairPage() {
  const { pid = "", pairId = "", stage } = useParams();
  const source = useSourceName(pid);
  const { data, isLoading, error } = useQuery({
    queryKey: ["pair", pairId],
    queryFn: () => get<PairDetail>(`/api/projects/${pid}/pairs/${pairId}`),
  });
  if (isLoading) return <ListLoading mt="xl" />;
  if (error || !data)
    return (
      <Alert color="red" mt="xl">
        {(error as Error)?.message ?? "Pair not found."}
      </Alert>
    );
  const def = PAIR_STAGES.find((s) => s.key === stage);
  if (!def)
    return (
      <Navigate to={`/projects/${pid}/pairs/${pairId}/${defaultPairStage(data.pair)}`} replace />
    );
  const descriptions: Record<string, string> = {
    alignment: `Which chapter of the ${source} book matches which chapter of the translation. Check the rows, read them side by side, untick what learning should skip (front matter, notes, a licence), then confirm.`,
    learn:
      "The AI reads every included chapter pair, notes the translator's choices, and merges them into this pair's knowledge base. Chapter pairs are read in parallel. Chapters already read are reused when you run it again, and your edits to the knowledge base are kept.",
    kb: "What the AI learned from this pair: names, terms, wordplay and style. Your edits are locked and kept when the pair is learned again.",
  };
  // The introduction is open until the page's step is done.
  const about: Record<string, boolean | undefined> = {
    alignment: data.alignment.status !== "confirmed",
    learn: data.pair.phase1.state === "none",
    kb: false,
  };

  return (
    <>
      <PageHeader
        key={def.key}
        context={displayTitle(data.pair.title)}
        title={def.label}
        description={descriptions[def.key]}
        about={about[def.key]}
        actions={<PairMenu pid={pid} pair={data.pair} />}
      />
      {def.key === "alignment" && <AlignmentPanel pid={pid} detail={data} />}
      {def.key === "learn" && <Phase1Panel pid={pid} pairId={pairId} />}
      {def.key === "kb" && <KbEditor pid={pid} scope="pair" targetId={pairId} />}
    </>
  );
}
