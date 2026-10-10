import type { JobContext } from "../jobs/runner.ts";
import { callStructured } from "../llm/call.ts";
import { LanguageNotesOutput, languageNotesBlocks } from "../prompts/language-notes.ts";
import type { AppContext } from "../server/context.ts";

/** Job: drafts the target-language notes that go into every system prompt. */
export async function languageNotesJob(app: AppContext, job: JobContext): Promise<void> {
  const projectId = job.job.projectId;
  const project = await app.projects.get(projectId);
  job.progress(0, 1, "Writing language notes");
  const result = await callStructured(app.rt, app.settings.target("utility"), {
    projectId,
    step: "utility",
    label: "language notes",
    blocks: languageNotesBlocks("English", project.targetLangName, project.targetLang),
    schema: LanguageNotesOutput,
    schemaName: "language_notes",
    answerBudget: 1500,
    useCache: false,
    signal: job.signal,
    onUsage: job.addUsage,
  });
  await app.projects.setLanguageNotes(projectId, `${result.value.markdown.trim()}\n`);
  job.progress(1, 1, "Language notes written");
  app.events.changed(projectId, "language-notes", projectId);
}
