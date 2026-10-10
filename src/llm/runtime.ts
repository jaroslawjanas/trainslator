import type { Settings } from "../shared/schemas/settings.ts";
import type { DataPaths } from "../store/paths.ts";
import { ActivityRegistry } from "./activity.ts";
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
  const limiter = new Limiter(
    (connectionId) =>
      options.settings().connections.find((c) => c.id === connectionId)?.maxParallel ?? 1,
  );
  const activity = new ActivityRegistry();
  return {
    paths,
    activity,
    clients: new ClientPool(),
    limiter,
    calibration,
    cache: new ResponseCache(paths),
    log: new CallLog(paths, {
      logBodies: options.logBodies ?? (() => false),
      onEntry: (entry) => activity.recordFinished(entry),
    }),
    waits: options.waits,
  };
}
