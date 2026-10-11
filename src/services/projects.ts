import { SOURCE_LANGUAGES } from "../languages/index.ts";
import {
  canonicalLanguageTag,
  directionOf,
  languageDisplayName,
  primarySubtag,
  scriptOf,
} from "../shared/languages.ts";
import { newId, nowIso } from "../shared/schemas/common.ts";
import { Book, Pair, Project } from "../shared/schemas/project.ts";
import {
  listDir,
  readJson,
  readText,
  removePath,
  writeFileAtomic,
  writeJson,
} from "../store/json.ts";
import type { DataPaths } from "../store/paths.ts";

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found.`);
    this.name = "NotFoundError";
  }
}

/** An error caused by the request, with a message meant for the user (HTTP 400). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export class ProjectStore {
  private readonly paths: DataPaths;

  constructor(paths: DataPaths) {
    this.paths = paths;
  }

  async list(): Promise<Project[]> {
    const out: Project[] = [];
    for (const id of await listDir(this.paths.projectsDir())) {
      try {
        const p = await readJson(this.paths.projectFile(id), Project);
        if (p) out.push(p);
      } catch {
        // skip folders that aren't projects
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Project> {
    const p = await readJson(this.paths.projectFile(id), Project);
    if (!p) throw new NotFoundError("Project");
    return p;
  }

  async create(input: { name: string; targetLang: string; sourceLang?: string }): Promise<Project> {
    const tag = canonicalLanguageTag(input.targetLang);
    if (!tag) throw new UserError(`"${input.targetLang}" isn't a valid language code.`);
    const sourceLang = canonicalLanguageTag(input.sourceLang ?? "en");
    if (!sourceLang || !SOURCE_LANGUAGES.includes(primarySubtag(sourceLang)))
      throw new UserError(
        `Books can be translated from ${SOURCE_LANGUAGES.map((t) => languageDisplayName(t)).join(", ")} for now.`,
      );
    if (primarySubtag(sourceLang) === primarySubtag(tag))
      throw new UserError("Choose a target language different from the source language.");
    const now = nowIso();
    const project: Project = {
      schemaVersion: 1,
      id: newId("pr"),
      name: input.name.trim() || languageDisplayName(tag),
      sourceLang,
      targetLang: tag,
      targetLangName: languageDisplayName(tag),
      targetScript: scriptOf(tag),
      direction: directionOf(tag),
      options: { pauseAfterPhase: true },
      usageResetAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return writeJson(this.paths.projectFile(project.id), Project, project);
  }

  /** Starts the Usage page's counts from now. */
  async resetUsage(id: string): Promise<Project> {
    const p = await this.get(id);
    return writeJson(this.paths.projectFile(id), Project, { ...p, usageResetAt: nowIso() });
  }

  async update(id: string, patch: { name?: string; pauseAfterPhase?: boolean }): Promise<Project> {
    const p = await this.get(id);
    const next: Project = {
      ...p,
      name: patch.name?.trim() || p.name,
      options: {
        ...p.options,
        pauseAfterPhase: patch.pauseAfterPhase ?? p.options.pauseAfterPhase,
      },
      updatedAt: nowIso(),
    };
    return writeJson(this.paths.projectFile(id), Project, next);
  }

  async touch(id: string): Promise<void> {
    const p = await this.get(id);
    await writeJson(this.paths.projectFile(id), Project, { ...p, updatedAt: nowIso() });
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await removePath(this.paths.project(id));
  }

  async languageNotes(id: string): Promise<string> {
    return (await readText(this.paths.languageNotes(id))) ?? "";
  }

  async setLanguageNotes(id: string, markdown: string): Promise<void> {
    await this.get(id);
    await writeFileAtomic(this.paths.languageNotes(id), markdown);
  }

  // Pairs and books -----------------------------------------------------------

  async pairs(pid: string): Promise<Pair[]> {
    const out: Pair[] = [];
    for (const id of await listDir(this.paths.pairsDir(pid))) {
      const p = await readJson(this.paths.pairFile(pid, id), Pair).catch(() => undefined);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async pair(pid: string, id: string): Promise<Pair> {
    const p = await readJson(this.paths.pairFile(pid, id), Pair);
    if (!p) throw new NotFoundError("Reference pair");
    return p;
  }

  async savePair(pid: string, pair: Pair): Promise<Pair> {
    return writeJson(this.paths.pairFile(pid, pair.id), Pair, pair);
  }

  async books(pid: string): Promise<Book[]> {
    const out: Book[] = [];
    for (const id of await listDir(this.paths.booksDir(pid))) {
      const b = await readJson(this.paths.bookFile(pid, id), Book).catch(() => undefined);
      if (b) out.push(b);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async book(pid: string, id: string): Promise<Book> {
    const b = await readJson(this.paths.bookFile(pid, id), Book);
    if (!b) throw new NotFoundError("Book");
    return b;
  }

  async saveBook(pid: string, book: Book): Promise<Book> {
    return writeJson(this.paths.bookFile(pid, book.id), Book, book);
  }
}
