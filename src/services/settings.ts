import { z } from "zod";
import type { AdvisorTarget } from "../llm/advisor.ts";
import type { CallTarget } from "../llm/call.ts";
import { LlmError } from "../llm/errors.ts";
import {
  type AdvisorSettings,
  type Connection,
  defaultSettings,
  defaultStepSettings,
  MASKED,
  type Model,
  Settings,
  type StepSettings,
} from "../shared/schemas/settings.ts";
import { STEP_INFO, type Step } from "../shared/steps.ts";
import { readJson, StoreError, withFileLock, writeJson } from "../store/json.ts";
import type { DataPaths } from "../store/paths.ts";
import { UserError } from "./projects.ts";
import { migrateRawSettings, migrateSettings } from "./settings-migrate.ts";

/** In-memory settings, persisted to settings.json. API keys never leave the server unmasked. */
export class SettingsService {
  private current: Settings = defaultSettings();
  private readonly paths: DataPaths;

  constructor(paths: DataPaths) {
    this.paths = paths;
  }

  async load(): Promise<void> {
    const raw = await readJson(this.paths.settings(), z.unknown());
    if (raw === undefined) {
      this.current = defaultSettings();
      return;
    }
    const upgraded = migrateRawSettings(raw);
    const parsed = Settings.safeParse(upgraded);
    if (!parsed.success)
      throw new StoreError(
        `settings.json doesn't match its schema: ${parsed.error.message}`,
        this.paths.settings(),
        { cause: parsed.error },
      );
    this.current = parsed.data;
    const migrated = migrateSettings(this.current);
    if (migrated || JSON.stringify(upgraded) !== JSON.stringify(raw))
      await this.save(migrated ?? this.current);
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
      advisor: clearAdvisor(this.current.advisor, removedModels),
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
      advisor: clearAdvisor(this.current.advisor, new Set([id])),
    });
  }

  async setSteps(steps: Settings["steps"]): Promise<Settings> {
    return this.save({ ...this.current, steps });
  }

  async setAdvisor(advisor: AdvisorSettings): Promise<Settings> {
    if (advisor.modelId && !this.model(advisor.modelId))
      throw new UserError("The advisor's model doesn't exist.");
    if (advisor.enabled && !advisor.modelId)
      throw new UserError("Choose the advisor's model before turning the advisor on.");
    return this.save({ ...this.current, advisor });
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
    return {
      connection,
      model,
      step: stepSettings,
      advisor: this.advisorFor(stepSettings, connection),
    };
  }

  /**
   * A step's settings with another model chosen for one request (e.g. "draft
   * with" a model picked on the page). No advisor.
   */
  targetWith(step: Step, modelId: string): CallTarget {
    const model = this.model(modelId);
    if (!model) throw new UserError("That model no longer exists.");
    const connection = this.connection(model.connectionId);
    if (!connection)
      throw new LlmError("config", `The connection of model "${model.label}" no longer exists.`);
    return {
      connection,
      model,
      step: { ...this.current.steps[step], modelId: model.id, consultAdvisor: false },
    };
  }

  /**
   * The advisor a step may consult, or null when the advisor is off, the
   * step may not, or its model can't call tools (Claude Code).
   */
  private advisorFor(step: StepSettings, asking: Connection): AdvisorTarget | null {
    const a = this.current.advisor;
    if (!a.enabled || !step.consultAdvisor || asking.kind === "claude_code") return null;
    const model = a.modelId ? this.model(a.modelId) : undefined;
    if (!model)
      throw new LlmError(
        "config",
        "The advisor is on, but its model isn't set. Choose one in Settings → Step defaults.",
      );
    const connection = this.connection(model.connectionId);
    if (!connection)
      throw new LlmError(
        "config",
        `The connection of the advisor "${model.label}" no longer exists.`,
      );
    return {
      connection,
      model,
      step: {
        ...defaultStepSettings(),
        modelId: model.id,
        reasoning: a.reasoning,
        maxOutputTokens: a.maxOutputTokens,
      },
      maxConsultations: a.maxConsultations,
    };
  }
}

/** A removed advisor model switches the advisor off. */
function clearAdvisor(advisor: AdvisorSettings, removed: Set<string>): AdvisorSettings {
  return advisor.modelId && removed.has(advisor.modelId)
    ? { ...advisor, modelId: null, enabled: false }
    : advisor;
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
