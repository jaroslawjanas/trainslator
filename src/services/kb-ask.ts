import { renderKb } from "../kb/render.ts";
import { callStructured } from "../llm/call.ts";
import { loadSteps } from "../pipeline/phase2.ts";
import { bookKnowledge } from "../pipeline/phase3-job.ts";
import { KbAnswer, kbQuestionBlocks } from "../prompts/kb-question.ts";
import type { AppContext } from "../server/context.ts";
import { languageDisplayName } from "../shared/languages.ts";
import type { StepSettings } from "../shared/schemas/settings.ts";
import { type KbScope, loadKb } from "./kb.ts";
import { NotFoundError, UserError } from "./projects.ts";

/** Most chapter summaries sent with a question. */
const MAX_SYNOPSES = 8;

/**
 * Asks a model to settle an open question in a knowledge base. Returns its
 * proposal; nothing is saved (you answer the question with it, or not).
 * The advisor's model answers with the advisor's settings; another model
 * with the phase 2 settings.
 */
export async function askAboutEntry(
  app: AppContext,
  scope: KbScope,
  entryId: string,
  modelId: string,
): Promise<KbAnswer> {
  const { kb } = await loadKb(app, scope);
  const entry = kb.entries.find((e) => e.id === entryId);
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status !== "open" || !entry.question)
    throw new UserError("This entry has no open question.");
  const model = app.settings.model(modelId);
  const connection = model ? app.settings.connection(model.connectionId) : undefined;
  if (!model || !connection) throw new UserError("That model no longer exists.");

  const settings = app.settings.get();
  const advisor = settings.advisor;
  const step: StepSettings =
    advisor.modelId === model.id
      ? {
          ...settings.steps["phase2.review"],
          modelId: model.id,
          reasoning: advisor.reasoning,
          maxOutputTokens: advisor.maxOutputTokens,
          consultAdvisor: false,
        }
      : { ...settings.steps["phase2.review"], modelId: model.id, consultAdvisor: false };

  const project = await app.projects.get(scope.pid);
  let referenceKb: string | null = null;
  let synopses: string[] = [];
  if (scope.kind === "book") {
    referenceKb = (await bookKnowledge(app, scope.pid, scope.id)).referenceKb;
    const refs = new Set(entry.refs);
    synopses = (await loadSteps(app, scope.pid, scope.id))
      .filter((s) => refs.has(s.segmentId) && s.synopsis)
      .map((s) => s.synopsis)
      .slice(0, MAX_SYNOPSES);
  }
  const others = { ...kb, entries: kb.entries.filter((e) => e.id !== entry.id) };
  const ownKb = others.entries.length + others.styleRules.length > 0 ? renderKb(others) : null;

  const { id: _id, refs: _refs, updatedAt: _at, origin: _origin, ...shown } = entry;
  const result = await callStructured(
    app.rt,
    { connection, model, step },
    {
      projectId: scope.pid,
      step: "phase2.review",
      label: `Open question · ${entry.source}`.slice(0, 120),
      blocks: kbQuestionBlocks({
        sourceName: languageDisplayName(project.sourceLang),
        targetName: project.targetLangName,
        languageNotes: await app.projects.languageNotes(scope.pid),
        referenceKb,
        ownKb,
        synopses,
        entry: JSON.stringify(shown, null, 1),
        question: entry.question,
      }),
      schema: KbAnswer,
      schemaName: "kb_answer",
      answerBudget: 1500,
      useCache: false,
      lane: "interactive",
    },
  );
  return result.value;
}
