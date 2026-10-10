import type { Settings } from "../shared/schemas/settings.ts";
import type { DataPaths } from "../store/paths.ts";
import { ResponseCache } from "./cache.ts";
import { CalibrationStore } from "./calibration.ts";
import type { LlmRuntime } from "./call.ts";
import { ClientPool } from "./client.ts";
import { Limiter } from "./limiter.ts";
import { CallLog } from "./log.ts";

export interface RuntimeOptions {
  /** Current settings (read synchronously by the limiter). */
  settings: () => Settings;
  logBodies?: () => boolean;
  waits?: LlmRuntime["waits"];
  /** Persist calibration (default true). */
  persistCalibration?: boolean;
}

export async function createLlmRuntime(
  paths: DataPaths,
  options: RuntimeOptions,
): Promise<LlmRuntime> {
  const calibration = new CalibrationStore(
    options.persistCalibration === false ? null : paths.calibration(),
  );
  await calibration.load();
  const limiter = new Limiter((modelId) => {
    const settings = options.settings();
    const model = settings.models.find((m) => m.id === modelId);
    const connection = model
      ? settings.connections.find((c) => c.id === model.connectionId)
      : undefined;
    return {
      modelLimit: model?.maxParallel ?? 1,
      connectionId: connection?.id ?? "unknown",
      connectionLimit: connection?.maxParallel ?? null,
    };
  });
  return {
    paths,
    clients: new ClientPool(),
    limiter,
    calibration,
    cache: new ResponseCache(paths),
    log: new CallLog(paths, { logBodies: options.logBodies ?? (() => false) }),
    waits: options.waits,
  };
}
