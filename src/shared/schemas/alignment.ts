import { z } from "zod";
import { Id, SchemaVersion } from "./common.ts";

export const AlignUnit = z.object({
  id: Id,
  /** Source-book segment ids (in order). Empty = nothing on this side. */
  source: z.array(Id),
  /** Translated-book segment ids (in order). */
  target: z.array(Id),
  include: z.boolean(),
  /** 0–1 from the automatic proposal; null when set by hand. */
  confidence: z.number().min(0).max(1).nullable(),
});
export type AlignUnit = z.infer<typeof AlignUnit>;

export const Alignment = z.object({
  schemaVersion: SchemaVersion,
  status: z.enum(["proposed", "confirmed"]),
  tocDepthSource: z.number().int().positive(),
  tocDepthTarget: z.number().int().positive(),
  units: z.array(AlignUnit),
});
export type Alignment = z.infer<typeof Alignment>;
