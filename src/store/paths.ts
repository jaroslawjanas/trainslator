import path from "node:path";
import { ID_RE } from "../shared/schemas/common.ts";

/**
 * TRAINSLATOR_DATA_DIR if set, else ./data. The standalone app keeps its data
 * next to the program instead, since it may be started from any folder.
 */
export function defaultDataDir(options: { standalone?: boolean } = {}): string {
  const fromEnv = process.env.TRAINSLATOR_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return options.standalone
    ? path.join(path.dirname(process.execPath), "data")
    : path.resolve("data");
}

function checkId(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid id: ${id}`);
  return id;
}

const pad3 = (n: number) => String(n).padStart(3, "0");

/** Every path the app writes, in one place. Ids are validated before they become paths. */
export class DataPaths {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  settings() {
    return path.join(this.root, "settings.json");
  }
  calibration() {
    return path.join(this.root, "calibration.json");
  }
  jobsDir() {
    return path.join(this.root, "jobs");
  }
  job(jobId: string) {
    return path.join(this.jobsDir(), `${checkId(jobId)}.json`);
  }
  corpusDir() {
    return path.join(this.root, "corpus");
  }
  projectsDir() {
    return path.join(this.root, "projects");
  }
  project(pid: string) {
    return path.join(this.projectsDir(), checkId(pid));
  }
  projectFile(pid: string) {
    return path.join(this.project(pid), "project.json");
  }
  languageNotes(pid: string) {
    return path.join(this.project(pid), "language-notes.md");
  }
  callsLog(pid: string) {
    return path.join(this.project(pid), "logs", "calls.jsonl");
  }
  callDetail(pid: string, callId: string) {
    return path.join(this.project(pid), "logs", "calls", `${checkId(callId)}.json`);
  }
  promptBlob(pid: string, hash: string) {
    return path.join(this.project(pid), "logs", "blocks", `${checkId(hash)}.txt`);
  }
  llmCacheDir(pid: string) {
    return path.join(this.project(pid), "cache", "llm");
  }
  llmCache(pid: string, hash: string) {
    return path.join(this.llmCacheDir(pid), `${checkId(hash)}.json`);
  }

  // Reference pairs
  pairsDir(pid: string) {
    return path.join(this.project(pid), "pairs");
  }
  pair(pid: string, pairId: string) {
    return path.join(this.pairsDir(pid), checkId(pairId));
  }
  pairFile(pid: string, pairId: string) {
    return path.join(this.pair(pid, pairId), "pair.json");
  }
  pairEpub(pid: string, pairId: string, side: "source" | "target") {
    return path.join(this.pair(pid, pairId), `${side}.epub`);
  }
  pairStructure(pid: string, pairId: string, side: "source" | "target") {
    return path.join(this.pair(pid, pairId), `structure.${side}.json`);
  }
  alignment(pid: string, pairId: string) {
    return path.join(this.pair(pid, pairId), "alignment.json");
  }
  phase1Findings(pid: string, pairId: string, unitIndex: number, part: number | null) {
    const name = part === null ? `u${unitIndex}.json` : `u${unitIndex}.p${part}.json`;
    return path.join(this.pair(pid, pairId), "phase1", "findings", name);
  }
  phase1FindingsDir(pid: string, pairId: string) {
    return path.join(this.pair(pid, pairId), "phase1", "findings");
  }
  phase1Groups(pid: string, pairId: string) {
    return path.join(this.pair(pid, pairId), "phase1", "groups.json");
  }
  phase1Merge(pid: string, pairId: string, batch: number | "style") {
    return path.join(this.pair(pid, pairId), "phase1", "merge", `b${batch}.json`);
  }
  phase1MergeDir(pid: string, pairId: string) {
    return path.join(this.pair(pid, pairId), "phase1", "merge");
  }
  pairKb(pid: string, pairId: string) {
    return path.join(this.pair(pid, pairId), "kb.json");
  }
  pairKbOverrides(pid: string, pairId: string) {
    return path.join(this.pair(pid, pairId), "kb.overrides.json");
  }

  // Books
  booksDir(pid: string) {
    return path.join(this.project(pid), "books");
  }
  book(pid: string, bookId: string) {
    return path.join(this.booksDir(pid), checkId(bookId));
  }
  bookFile(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "book.json");
  }
  bookEpub(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "source.epub");
  }
  bookStructure(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "structure.json");
  }
  bookSetup(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "setup.json");
  }
  bookKb(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "kb.json");
  }
  bookKbOverrides(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "kb.overrides.json");
  }
  phase2Dir(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "phase2");
  }
  phase2Snapshot(pid: string, bookId: string, step: number) {
    return path.join(this.phase2Dir(pid, bookId), `kb.v${pad3(step)}.json`);
  }
  phase2Synopsis(pid: string, bookId: string, step: number) {
    return path.join(this.phase2Dir(pid, bookId), `synopsis.${pad3(step)}.json`);
  }
  phase2Step(pid: string, bookId: string, step: number) {
    return path.join(this.phase2Dir(pid, bookId), `step.${pad3(step)}.json`);
  }
  phase2Review(pid: string, bookId: string) {
    return path.join(this.phase2Dir(pid, bookId), "review.json");
  }
  phase2Pending(pid: string, bookId: string) {
    return path.join(this.phase2Dir(pid, bookId), "pending-answers.json");
  }
  phase3Dir(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "phase3");
  }
  phase3Units(pid: string, bookId: string, docIndex: number) {
    return path.join(this.phase3Dir(pid, bookId), "units", `d${docIndex}.json`);
  }
  phase3Plan(pid: string, bookId: string) {
    return path.join(this.phase3Dir(pid, bookId), "plan.json");
  }
  phase3Result(pid: string, bookId: string, chunkIndex: number) {
    return path.join(this.phase3Dir(pid, bookId), "results", `c${chunkIndex}.json`);
  }
  phase3ResultsDir(pid: string, bookId: string) {
    return path.join(this.phase3Dir(pid, bookId), "results");
  }
  phase3Edits(pid: string, bookId: string) {
    return path.join(this.phase3Dir(pid, bookId), "edits.json");
  }
  phase3Glossary(pid: string, bookId: string) {
    return path.join(this.phase3Dir(pid, bookId), "glossary.json");
  }
  phase3Toc(pid: string, bookId: string) {
    return path.join(this.phase3Dir(pid, bookId), "toc.json");
  }
  historyDir(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "history");
  }
  historyIndex(pid: string, bookId: string) {
    return path.join(this.historyDir(pid, bookId), "history.json");
  }
  savedTranslation(pid: string, bookId: string, id: string) {
    return path.join(this.historyDir(pid, bookId), "translations", `${id}.json`);
  }
  savedBuild(pid: string, bookId: string, id: string) {
    return path.join(this.historyDir(pid, bookId), "builds", `${id}.epub`);
  }
  /** A saved knowledge base: kb.json, kb.overrides.json and the phase2 folder. */
  savedKnowledge(pid: string, bookId: string, id: string) {
    return path.join(this.historyDir(pid, bookId), "knowledge", id);
  }
  /** Which phase 2 job already did its one-time preparation (clearing, saving). */
  phase2StartMarker(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "phase2.started.json");
  }
  /** Which "translate the whole book again" job already cleared the translation. */
  redoMarker(pid: string, bookId: string) {
    return path.join(this.historyDir(pid, bookId), "redo.json");
  }
  outputDir(pid: string, bookId: string) {
    return path.join(this.book(pid, bookId), "output");
  }
  buildReport(pid: string, bookId: string) {
    return path.join(this.outputDir(pid, bookId), "report.json");
  }
}
