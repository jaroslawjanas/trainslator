import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlmRuntime } from "../llm/call.ts";
import { KIND_PRESETS } from "../llm/presets.ts";
import { createLlmRuntime } from "../llm/runtime.ts";
import {
  type Connection,
  type ConnectionKind,
  defaultSettings,
  defaultStepSettings,
  type Model,
  type Settings,
  type StepSettings,
} from "../shared/schemas/settings.ts";
import { DataPaths } from "../store/paths.ts";

export function makeConnection(baseUrl: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn1",
    name: "Fake",
    kind: "custom",
    baseUrl,
    apiKey: { kind: "literal", value: "test-key" },
    headers: [],
    maxParallel: 4,
    timeoutSec: 30,
    idleTimeoutSec: 30,
    maxRetries: 0,
    stream: false,
    ...overrides,
  };
}

export function makeModel(kind: ConnectionKind = "custom", overrides: Partial<Model> = {}): Model {
  return {
    id: "model1",
    connectionId: "conn1",
    modelName: "fake-model",
    label: "Fake model",
    contextWindow: 32_000,
    maxOutputTokens: 8_000,
    pricing: null,
    ...KIND_PRESETS[kind].model,
    ...overrides,
  };
}

export function makeStep(overrides: Partial<StepSettings> = {}): StepSettings {
  return { ...defaultStepSettings(), modelId: "model1", ...overrides };
}

export interface TestRuntime {
  rt: LlmRuntime;
  dir: string;
  paths: DataPaths;
  settings: Settings;
  cleanup(): Promise<void>;
}

export async function makeRuntime(connection: Connection, model: Model): Promise<TestRuntime> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trainslator-llm-"));
  const paths = new DataPaths(dir);
  const settings: Settings = { ...defaultSettings(), connections: [connection], models: [model] };
  const rt = await createLlmRuntime(paths, {
    settings: () => settings,
    waits: { rateLimitMs: 20, transportMs: 10 },
    persistCalibration: false,
  });
  return {
    rt,
    dir,
    paths,
    settings,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
