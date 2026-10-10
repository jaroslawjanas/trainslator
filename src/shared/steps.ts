import { z } from "zod";

export const STEPS = [
  "utility",
  "phase1.read",
  "phase1.merge",
  "phase2.chapter",
  "phase2.review",
  "phase3.translate",
] as const;

export const Step = z.enum(STEPS);
export type Step = z.infer<typeof Step>;

export interface StepInfo {
  label: string;
  description: string;
  /** Suggested model strength, shown as a hint in the settings. */
  suggestedTier: "fast" | "medium" | "strong";
}

export const STEP_INFO: Record<Step, StepInfo> = {
  utility: {
    label: "Utility",
    description: "Small jobs: language notes, table of contents and book title translation.",
    suggestedTier: "medium",
  },
  "phase1.read": {
    label: "Phase 1: read chapters",
    description: "Reads each chapter pair of a reference book and lists the translator's choices.",
    suggestedTier: "fast",
  },
  "phase1.merge": {
    label: "Phase 1: merge findings",
    description: "Turns the findings from all chapters into the pair's knowledge base.",
    suggestedTier: "medium",
  },
  "phase2.chapter": {
    label: "Phase 2: read chapters",
    description: "Reads the new book chapter by chapter and updates its knowledge base.",
    suggestedTier: "medium",
  },
  "phase2.review": {
    label: "Phase 2: final review",
    description: "Cleans up the book's knowledge base after all chapters are read.",
    suggestedTier: "medium",
  },
  "phase3.translate": {
    label: "Phase 3: translate",
    description: "Translates the book chunk by chunk using the knowledge bases.",
    suggestedTier: "strong",
  },
};
