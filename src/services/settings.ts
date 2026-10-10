import type { CallTarget } from "../llm/call.ts";
import { LlmError } from "../llm/errors.ts";
import {
  type Connection,
  defaultSettings,
  MASKED,
  type Model,
  Settings,
  type StepSettings,
} from "../shared/schemas/settings.ts";
import { STEP_INFO, type Step } from "../shared/steps.ts";
import { readJson, withFileLock, writeJson } from "../store/json.ts";
import type { DataPaths } from "../store/paths.ts";
import { UserError } from "./projects.ts";

/** In-memory settings, persisted to settings.json. API keys never leave the server unmasked. */
export class SettingsService {
  private current: Settings = defaultSettings();
  private readonly paths: DataPaths;

  constructor(paths: DataPaths) {
    this.paths = paths;
  }

  async load(): Promise<void> {
    this.current = (await readJson(this.paths.settings(), Settings)) ?? defaultSettings();
  }

  get(): Settings {
    return this.current;
  }

  private async save(next: Settings): Promise<Settings> {
    return withFileLock(this.paths.settings(), async () => {
      this.current = await writeJson(this.paths.settings(), Settings, next);
      return this.current;
    });
  }

  /** Settings with stored keys and secret header values masked. */
  masked(): Settings {
    return {
      ...this.current,
      connections: this.current.connections.map(maskConnection),
    };
  }

  async upsertConnection(input: Connection): Promise<Settings> {
    const existing = this.current.connections.find((c) => c.id === input.id);
    const next: Connection = { ...input };
    // A masked or empty key means "keep the stored one", unless the URL changed.
    if (
      next.apiKey.kind === "literal" &&
      (next.apiKey.value === MASKED || next.apiKey.value === "")
    ) {
      if (existing?.apiKey.kind === "literal" && existing.baseUrl === next.baseUrl) {
        next.apiKey = existing.apiKey;
      } else if (existing && existing.baseUrl !== next.baseUrl) {
        throw new UserError(
          "The base URL changed, so the stored API key was not reused. Enter the key again.",
        );
      } else {
        next.apiKey = { kind: "literal", value: "" };
      }
    }
    next.headers = next.headers.map((h) => {
      if (h.secret && h.value === MASKED) {
        const old = existing?.headers.find((o) => o.name === h.name);
        if (old && existing?.baseUrl === next.baseUrl) return { ...h, value: old.value };
        throw new UserError(`Enter the value of header ${h.name} again (the base URL changed).`);
      }
      return h;
    });
    const connections = existing
      ? this.current.connections.map((c) => (c.id === next.id ? next : c))
      : [...this.current.connections, next];
    return this.save({ ...this.current, connections });
  }

  async deleteConnection(id: string): Promise<Settings> {
    const models = this.current.models.filter((m) => m.connectionId !== id);
    const removedModels = new Set(
      this.current.models.filter((m) => m.connectionId === id).map((m) => m.id),
    );
    return this.save({
      ...this.current,
      connections: this.current.connections.filter((c) => c.id !== id),
      models,
      steps: clearModels(this.current.steps, removedModels),
    });
  }

  async upsertModel(model: Model): Promise<Settings> {
    if (!this.current.connections.some((c) => c.id === model.connectionId)) {
      throw new UserError("The model's connection doesn't exist.");
    }
    const exists = this.current.models.some((m) => m.id === model.id);
    const models = exists
      ? this.current.models.map((m) => (m.id === model.id ? model : m))
      : [...this.current.models, model];
    return this.save({ ...this.current, models });
  }

  async deleteModel(id: string): Promise<Settings> {
    return this.save({
      ...this.current,
      models: this.current.models.filter((m) => m.id !== id),
      steps: clearModels(this.current.steps, new Set([id])),
    });
  }

  async setSteps(steps: Settings["steps"]): Promise<Settings> {
    return this.save({ ...this.current, steps });
  }

  connection(id: string): Connection | undefined {
    return this.current.connections.find((c) => c.id === id);
  }

  model(id: string): Model | undefined {
    return this.current.models.find((m) => m.id === id);
  }

  /** The model, connection and settings for a step, or a clear error telling the user what to set up. */
  target(step: Step): CallTarget {
    const stepSettings: StepSettings = this.current.steps[step];
    const label = STEP_INFO[step].label;
    if (!stepSettings.modelId) {
      throw new LlmError(
        "config",
        `No model is chosen for "${label}". Choose one in Settings → Step defaults.`,
      );
    }
    const model = this.model(stepSettings.modelId);
    if (!model)
      throw new LlmError(
        "config",
        `The model chosen for "${label}" no longer exists. Choose another in Settings → Step defaults.`,
      );
    const connection = this.connection(model.connectionId);
    if (!connection)
      throw new LlmError("config", `The connection of model "${model.label}" no longer exists.`);
    return { connection, model, step: stepSettings };
  }
}

function clearModels(steps: Settings["steps"], removed: Set<string>): Settings["steps"] {
  const out = { ...steps };
  for (const key of Object.keys(out) as Step[]) {
    if (out[key].modelId && removed.has(out[key].modelId))
      out[key] = { ...out[key], modelId: null };
  }
  return out;
}

export function maskConnection(c: Connection): Connection {
  return {
    ...c,
    apiKey:
      c.apiKey.kind === "literal" && c.apiKey.value ? { kind: "literal", value: MASKED } : c.apiKey,
    headers: c.headers.map((h) => (h.secret ? { ...h, value: MASKED } : h)),
  };
}
