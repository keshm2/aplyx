import { useState } from "react";

/**
 * Which field on the current page is focused, plus the commit/percentage
 * bookkeeping the sidebar's progress bar needs. `committed` is the live
 * mirror of src/config/targets.json's `_onboarding.committed_fields` — ids
 * the wizard has already asked-and-recorded (filled or explicitly
 * skipped). Committing is idempotent: re-committing an already-committed
 * field (e.g. editing a value on a page you've come back to) never
 * double-counts it.
 */
export function useFieldFocus(initialCommitted: string[]) {
  const [focusIndex, setFocusIndex] = useState(0);
  const [committed, setCommitted] = useState<Set<string>>(() => new Set(initialCommitted));

  /** Returns the updated set so the caller can persist it in the same
   *  tick it decides where to navigate next, instead of racing a stale
   *  closure on the next render. */
  function commit(id: string): Set<string> {
    if (committed.has(id)) return committed;
    const next = new Set(committed);
    next.add(id);
    setCommitted(next);
    return next;
  }

  function percentage(total: number): number {
    return Math.round((committed.size / total) * 100);
  }

  return { focusIndex, setFocusIndex, committed, commit, percentage };
}
