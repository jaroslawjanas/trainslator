import { Alert, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router";
import { get } from "../api/client.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { displayTitle } from "../lib/format.ts";
import { BOOK_STAGES, defaultBookStage } from "../lib/stages.ts";
import { BuildPanel } from "./book/BuildPanel.tsx";
import { HistoryPanel } from "./book/HistoryPanel.tsx";
import { Phase2Panel } from "./book/Phase2Panel.tsx";
import { ReviewPanel } from "./book/ReviewPanel.tsx";
import { SetupPanel } from "./book/SetupPanel.tsx";
import { TranslatePanel } from "./book/TranslatePanel.tsx";
import type { BookDetail } from "./book/types.ts";
import { KbEditor } from "./kb/KbEditor.tsx";
import { useProject, useSourceName } from "./ProjectPage.tsx";

const DESCRIPTIONS: Record<string, (target: string, source: string) => string> = {
  setup: () =>
    "Which reference knowledge the AI gets, which chapters phase 2 reads, and which files are translated.",
  read: () =>
    "Phase 2. Before translating, the AI reads the book chapter by chapter. It writes a synopsis of each chapter and builds the book's knowledge base, with open questions where it can't decide yet.",
  kb: (target) =>
    `Names, terms and facts in this book, with their ${target} translations. What you edit is locked and kept when phases run again.`,
  translate: (_, source) =>
    `Phase 3. The AI translates the book in chunks or whole chapters, following both knowledge bases. Review it chapter by chapter: the ${source} on the left page, the translation on the right.`,
  review: (_, source) =>
    `Up to three versions side by side: the ${source}, the current translation and saved ones. Edit any of them, rewrite a passage or part of it with a model, or copy a passage from one version to another. The current translation is the one that gets built.`,
  build: () =>
    "Builds the translated EPUB from the original files. The translation replaces the text; styles, images, links and footnotes stay as they were.",
  history: () =>
    "Every translation of this book and every EPUB built from it. A translation is saved after each run, at each build, and before it's replaced. Compare a saved translation with the current one, restore it, or download its builds.",
};

export function BookPage() {
  const { pid = "", bookId = "", stage } = useParams();
  const project = useProject(pid);
  const source = useSourceName(pid);
  const { data, isLoading, error } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => get<BookDetail>(`/api/projects/${pid}/books/${bookId}`),
  });
  if (isLoading) return <Loader size="sm" mt="xl" />;
  if (error || !data)
    return (
      <Alert color="red" mt="xl">
        {(error as Error)?.message ?? "Book not found."}
      </Alert>
    );
  const def = BOOK_STAGES.find((s) => s.key === stage);
  if (!def)
    return (
      <Navigate to={`/projects/${pid}/books/${bookId}/${defaultBookStage(data.book)}`} replace />
    );
  const targetName = project.data?.project.targetLangName ?? "target-language";

  return (
    <>
      <PageHeader
        context={displayTitle(data.book.title)}
        title={def.label}
        description={DESCRIPTIONS[def.key]?.(targetName, source)}
      />
      {def.key === "setup" && <SetupPanel pid={pid} detail={data} />}
      {def.key === "read" && <Phase2Panel pid={pid} detail={data} />}
      {def.key === "kb" && <KbEditor pid={pid} scope="book" targetId={bookId} />}
      {def.key === "translate" && <TranslatePanel pid={pid} detail={data} />}
      {def.key === "review" && <ReviewPanel pid={pid} bookId={bookId} />}
      {def.key === "build" && <BuildPanel pid={pid} detail={data} />}
      {def.key === "history" && <HistoryPanel pid={pid} bookId={bookId} />}
    </>
  );
}
