import { Alert, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router";
import { get } from "../api/client.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { displayTitle } from "../lib/format.ts";
import { defaultPairStage, PAIR_STAGES } from "../lib/stages.ts";
import { KbEditor } from "./kb/KbEditor.tsx";
import { AlignmentPanel, type PairDetail } from "./pair/AlignmentPanel.tsx";
import { Phase1Panel } from "./pair/Phase1Panel.tsx";

export function PairPage() {
  const { pid = "", pairId = "", stage } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["pair", pairId],
    queryFn: () => get<PairDetail>(`/api/projects/${pid}/pairs/${pairId}`),
  });
  if (isLoading) return <Loader size="sm" mt="xl" />;
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
    alignment:
      "Which chapter of the English book matches which chapter of the translation. Check the rows, untick what phase 1 should skip (front matter, notes, a licence), then confirm.",
    learn:
      "Phase 1. The AI reads every included chapter pair, notes the translator's choices, and merges them into this pair's knowledge base.",
    kb: "What the AI learned from this pair: names, terms, wordplay and style. Your edits are locked and kept when phase 1 runs again.",
  };

  return (
    <>
      <PageHeader
        context={displayTitle(data.pair.title)}
        title={def.label}
        description={descriptions[def.key]}
      />
      {def.key === "alignment" && <AlignmentPanel pid={pid} detail={data} />}
      {def.key === "learn" && <Phase1Panel pid={pid} pairId={pairId} />}
      {def.key === "kb" && <KbEditor pid={pid} scope="pair" targetId={pairId} />}
    </>
  );
}
