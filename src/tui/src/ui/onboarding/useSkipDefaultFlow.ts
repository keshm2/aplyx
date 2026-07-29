import { useEffect, useState } from "react";

/**
 * Shared "blank Enter -> show defaults + warning -> second blank Enter ->
 * commit defaults & advance" flow, used identically by the roles field
 * and both multi-entry fields (preferred locations, target companies).
 *
 * `resetKey` should change whenever focus moves to a different field
 * (e.g. `${pageIndex}:${focusIndex}`) so a stale "warned" flag never
 * carries over from one field to the next.
 */
export function useSkipDefaultFlow(resetKey: string) {
  const [warned, setWarned] = useState(false);

  useEffect(() => {
    setWarned(false);
  }, [resetKey]);

  /** Call on a blank Enter (no text typed / nothing added yet). Returns
   *  "commit-default" the second time in a row — the caller should commit
   *  its defaults and advance then — or "warn" the first time, meaning
   *  the caller should just show the warning and wait. */
  function resolveBlankEnter(): "warn" | "commit-default" {
    if (warned) {
      setWarned(false);
      return "commit-default";
    }
    setWarned(true);
    return "warn";
  }

  return { warned, resolveBlankEnter };
}
