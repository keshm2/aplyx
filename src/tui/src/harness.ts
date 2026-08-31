import { effectiveEnv } from "@aplyx/core/settings.js";
import { isKnownHarness, readHarnessConfig, detectHarnessOnPath as detectOnPath } from "@aplyx/core/harness.js";
import type { HarnessId } from "./theme.js";

function isKnown(value: string): value is Exclude<HarnessId, "auto"> {
  return isKnownHarness(value);
}

/** Same resolution order run_job_agent.py uses ahead of its own PATH
 *  auto-detect (APLYX_HARNESS/ARES_HARNESS env override, then
 *  src/config/harness.json): env override wins, then the config file, else
 *  "auto"; there's no CLI-on-PATH probe here since this only drives a
 *  cosmetic wave color, not the actual subprocess invocation. */
export function resolveHarnessId(root: string): HarnessId {
  const fromEnv = effectiveEnv(root, ["APLYX_HARNESS", "FLUX_HARNESS", "ARES_HARNESS"], "").value.trim();
  if (isKnown(fromEnv)) return fromEnv;
  const fromConfig = readHarnessConfig(root);
  if (fromConfig && isKnown(fromConfig)) return fromConfig;
  return "auto";
}

/** Which agent "Auto" would actually pick right now, or undefined when
 *  none of the four is installed. Cheap enough to call per render (a
 *  handful of stat calls), and never cached; installing an agent while
 *  the TUI is open should be reflected without a restart. */
export function detectHarnessOnPath(): Exclude<HarnessId, "auto"> | undefined {
  return detectOnPath();
}

/** The agent a run would use right now: an explicit choice if set,
 *  otherwise whatever auto-detect finds. */
export function effectiveHarness(root: string): Exclude<HarnessId, "auto"> | undefined {
  const resolved = resolveHarnessId(root);
  return resolved === "auto" ? detectHarnessOnPath() : resolved;
}
