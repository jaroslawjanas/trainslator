import { IconCheck, IconExclamationMark } from "@tabler/icons-react";
import type { MarkState } from "../lib/stages.ts";

const LABEL: Record<Exclude<MarkState, "neutral">, string> = {
  none: "not done yet",
  running: "running",
  done: "done",
  warning: "done, with errors",
  attention: "failed",
};

/**
 * A small circle: hollow (not done), spinning (running), filled (done or a
 * problem), or a quiet dot for pages that aren't tasks.
 */
export function StageMark({ state }: { state: MarkState }) {
  if (state === "neutral") return <span className="tr-mark" data-state="neutral" aria-hidden />;
  return (
    <span className="tr-mark" data-state={state} role="img" aria-label={LABEL[state]}>
      {state === "done" && <IconCheck size={10} stroke={3} />}
      {(state === "warning" || state === "attention") && (
        <IconExclamationMark size={10} stroke={3} />
      )}
    </span>
  );
}
