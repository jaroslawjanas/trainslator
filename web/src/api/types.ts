import type { Usage } from "../../../src/shared/schemas/common.ts";
import type { Job } from "../../../src/shared/schemas/jobs.ts";
import type { Book, Pair, Project } from "../../../src/shared/schemas/project.ts";
import type { ConnectionKind, Model, Settings } from "../../../src/shared/schemas/settings.ts";
import type { Step, StepInfo } from "../../../src/shared/steps.ts";

export type { Book, Job, Pair, Project, Settings, Usage };

export interface KindPreset {
  label: string;
  defaultBaseUrl: string;
  suggestedKeyEnv: string | null;
  model: Pick<
    Model,
    | "structuredOutput"
    | "maxTokensParam"
    | "sendTemperature"
    | "reasoningMode"
    | "reasoningTemplates"
    | "cacheMarkers"
    | "cacheMarkerTtl"
    | "sendPromptCacheKey"
  >;
  limits: { contextWindow: number; maxOutputTokens: number };
  notes: string;
}

export interface SettingsResponse {
  settings: Settings;
  presets: Record<ConnectionKind, KindPreset>;
  steps: Record<Step, StepInfo>;
}

export interface ListedModel {
  id: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: Model["pricing"];
}

export interface ProbeReport {
  checks: { name: string; ok: boolean | null; detail: string }[];
  suggestions: Partial<Model>;
  latencyMs: number | null;
  requests: number;
}

export interface ProjectSummary extends Project {
  pairCount: number;
  bookCount: number;
}

export interface ProjectDetail {
  project: Project;
  pairs: Pair[];
  books: Book[];
  languageNotes: string;
  jobs: Job[];
}

export interface UsageResponse {
  /** When the counts were last reset; null when they cover every request. */
  since: string | null;
  total: Usage;
  byStep: Record<string, Usage & { cacheHits: number }>;
  recent: {
    id: string;
    at: string;
    step: string;
    label: string;
    modelName: string;
    attempt: number;
    kind: "request" | "cache_hit";
    finishReason: string | null;
    latencyMs: number;
    usage: Usage;
    error: string | null;
  }[];
}
