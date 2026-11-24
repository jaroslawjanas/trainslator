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
 * A small mark: a hollow circle (not done), a spinning one (running), a plain
 * check (done), a filled circle (a problem), or a quiet dot for pages that
 * aren't tasks. Colour is kept for what needs you.
 */
export function StageMark({ state }: { state: MarkState }) {
  if (state === "neutral") return <span className="tr-mark" data-state="neutral" aria-hidden />;
  return (
    <span className="tr-mark" data-state={state} role="img" aria-label={LABEL[state]}>
      {state === "done" && <IconCheck size={14} stroke={2.2} />}
      {(state === "warning" || state === "attention") && (
        <IconExclamationMark size={10} stroke={3} />
      )}
    </span>
  );
}
