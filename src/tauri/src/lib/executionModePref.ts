import { useState } from "react";

/**
 * Hosted-account execution mode: bring your own coding agent (runs through
 * the same local install/harness config as local-only usage) vs. a fully
 * managed hosted plan. Only meaningful once signed in; SettingsPreferencesTab
 * hides the "Hosted plan" choice entirely for local-only users.
 *
 * "hosted" has no backend behind it yet, no billing, no managed execution
 * runtime. This is just UI state for now, same localStorage-only pattern
 * as uiPrefs.ts's theme/font, until that side actually gets built.
 */

export type ExecutionModePref = "byok" | "hosted";

const KEY = "aplyx.executionMode";

function loadExecutionModePref(): ExecutionModePref {
  return localStorage.getItem(KEY) === "hosted" ? "hosted" : "byok";
}

export function useExecutionModePref(): {
  mode: ExecutionModePref;
  setMode: (m: ExecutionModePref) => void;
} {
  const [mode, setModeState] = useState<ExecutionModePref>(loadExecutionModePref);
  return {
    mode,
    setMode(m) {
      localStorage.setItem(KEY, m);
      setModeState(m);
    },
  };
}
