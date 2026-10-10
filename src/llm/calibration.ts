import { Calibration, type ModelCalibration } from "../shared/schemas/settings.ts";
import { readJson, writeJson } from "../store/json.ts";

const MAX_SAMPLES = 50;

/** Learned per-model numbers: token estimate correction and reasoning-token samples. */
export class CalibrationStore {
  private data: Calibration = { schemaVersion: 1, models: {} };
  private loaded = false;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      this.data = (await readJson(this.file, Calibration)) ?? this.data;
    } catch {
      // A corrupt calibration file is simply rebuilt.
    }
  }

  private model(modelId: string): ModelCalibration {
    let m = this.data.models[modelId];
    if (!m) {
      m = { tokenFactor: 1, tokenSamples: 0, reasoningSamples: {} };
      this.data.models[modelId] = m;
    }
    return m;
  }

  tokenFactor(modelId: string): number {
    return this.data.models[modelId]?.tokenFactor ?? 1;
  }

  reasoningSamples(modelId: string, step: string): number[] {
    return this.data.models[modelId]?.reasoningSamples[step] ?? [];
  }

  /** Updates the estimate correction from a real prompt-token count. */
  recordPrompt(modelId: string, estimatedRaw: number, actual: number): void {
    if (estimatedRaw < 200 || actual <= 0) return;
    const m = this.model(modelId);
    const ratio = Math.min(4, Math.max(0.25, actual / estimatedRaw));
    const weight = Math.min(0.3, 1 / (m.tokenSamples + 1));
    m.tokenFactor = m.tokenFactor * (1 - weight) + ratio * weight;
    m.tokenSamples++;
    this.markDirty();
  }

  recordReasoning(modelId: string, step: string, tokens: number): void {
    const m = this.model(modelId);
    const list = m.reasoningSamples[step] ?? [];
    list.push(tokens);
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
    m.reasoningSamples[step] = list;
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.file || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 2000);
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    await writeJson(this.file, Calibration, this.data);
  }
}
