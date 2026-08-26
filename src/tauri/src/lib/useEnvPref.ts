import { useEffect, useState } from "react";
import { readEnvOverride, writeEnvOverride } from "./bridge";

/**
 * A yes/no APLYX_* setting backed by src/config/env.json. Same file and
 * mechanism as the TUI's effectiveEnv()/writeEnvOverride() (see theme.ts's
 * isReducedMotion()/is24HourClock()), so toggling it in the desktop app's
 * Settings shows up in the TUI right away, and vice versa. "1" means yes;
 * anything else, including no root, resolves to `fallback`.
 */
export function useBoolEnvPref(
  root: string | undefined,
  key: string,
  fallback: boolean,
): { value: boolean; setValue: (v: boolean) => void; ready: boolean } {
  const [value, setValueState] = useState(fallback);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!root) {
      setValueState(fallback);
      setReady(false);
      return;
    }
    let cancelled = false;
    readEnvOverride(root, key, { fallback: fallback ? "1" : "0" })
      .then((raw) => {
        if (!cancelled) {
          setValueState(raw === "1");
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, key]);

  return {
    value,
    ready,
    setValue(v: boolean) {
      setValueState(v); // optimistic, same pattern as the harness/scheduler toggles
      if (!root) return;
      void writeEnvOverride(root, key, v ? "1" : "0");
    },
  };
}
