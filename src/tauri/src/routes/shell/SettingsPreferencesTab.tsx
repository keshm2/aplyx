import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAuth } from "../../lib/AuthContext";
import {
  getSchedulerStatus,
  setSchedulerInstalled,
  type SchedulerStatus,
  detectHarnesses,
  readHarness,
  writeHarness,
  readEnvOverride,
  writeEnvOverride,
} from "../../lib/bridge";
import { useUiPrefs, type ThemePref } from "../../lib/uiPrefs";
import { useExecutionModePref } from "../../lib/executionModePref";
import { useBoolEnvPref } from "../../lib/useEnvPref";
import { applyReducedMotionAttr } from "../../lib/reducedMotion";
import { Switch } from "../../components/Switch";
import { HarnessPicker } from "../../components/HarnessPicker";
import { DiscordSettings } from "../../components/DiscordSettings";
import type { SettingsOutletContext } from "./SettingsShell";
import "../../components/formFields.css";

const SESSION_CAP_MAX = 25;

const CODE_STYLE = {
  background: "var(--surface-raised)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.35rem",
  fontFamily: "var(--font-mono)",
  fontSize: "0.9em",
};

const THEME_OPTIONS: { value: ThemePref; label: string; detail: string }[] = [
  { value: "system", label: "System", detail: "Follow the OS appearance" },
  { value: "light", label: "Light", detail: "Always light" },
  { value: "dark", label: "Dark", detail: "Always dark" },
];

/** Preferences tab: appearance, which coding agent runs your applies, run
 *  defaults, Discord notifications, and the background scheduler: every
 *  knob that shapes how a run behaves rather than who's signed in or
 *  which ATS credentials exist. */
export function SettingsPreferencesTab() {
  const { status } = useAuth();
  const { root } = useOutletContext<SettingsOutletContext>();
  const { theme, setTheme } = useUiPrefs();
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | undefined>(undefined);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  // Which direction the in-flight toggle is headed: lets the busy-state
  // copy say something specific ("Stopping current run…") instead of a
  // generic "Working…". Turning off is the one that can genuinely take a
  // few seconds (it has to wait for a live scheduled run to actually
  // finish exiting, not just fire a signal and hope); turning on is
  // normally near-instant.
  const [schedulerTarget, setSchedulerTarget] = useState<boolean | undefined>(undefined);
  const [schedulerError, setSchedulerError] = useState<string | undefined>(undefined);
  const { mode: executionMode, setMode: setExecutionMode } = useExecutionModePref();
  const [detectedHarnesses, setDetectedHarnesses] = useState<string[] | undefined>(undefined);
  const [configuredHarness, setConfiguredHarness] = useState<string | undefined>(undefined);
  const [harnessBusy, setHarnessBusy] = useState(false);
  const [harnessError, setHarnessError] = useState<string | undefined>(undefined);
  const [sessionCap, setSessionCap] = useState("");
  const [sessionCapError, setSessionCapError] = useState<string | undefined>(undefined);
  const { value: hour24Clock, setValue: setHour24Clock } = useBoolEnvPref(root, "APLYX_24_HOUR_CLOCK", false);
  const { value: reducedMotion, setValue: setReducedMotionRaw } = useBoolEnvPref(root, "APLYX_REDUCED_MOTION", false);
  const { value: scheduledAutoApply, setValue: setScheduledAutoApply } = useBoolEnvPref(
    root,
    "APLYX_SCHEDULED_AUTO_APPLY",
    false,
  );
  // This hook instance is component-local (see useEnvPref.ts), so other
  // mounted surfaces (AppShell applies the attribute on boot, see its own
  // effect) won't see this change reactively. Applying it directly here
  // too means toggling takes effect immediately without needing a shared
  // store just for one boolean.
  function setReducedMotion(v: boolean) {
    setReducedMotionRaw(v);
    applyReducedMotionAttr(v);
  }

  useEffect(() => {
    if (!root) return;
    getSchedulerStatus(root)
      .then(setSchedulerStatus)
      .catch(() => setSchedulerStatus(undefined));
  }, [root]);

  useEffect(() => {
    detectHarnesses()
      .then(setDetectedHarnesses)
      .catch(() => setDetectedHarnesses([]));
  }, []);

  useEffect(() => {
    if (!root) {
      setConfiguredHarness(undefined);
      return;
    }
    readHarness(root)
      .then(setConfiguredHarness)
      .catch(() => setConfiguredHarness(undefined));
  }, [root]);

  useEffect(() => {
    if (!root) {
      setSessionCap("");
      return;
    }
    readEnvOverride(root, "APLYX_SESSION_CAP", { legacyKeys: ["FLUX_SESSION_CAP", "ARES_SESSION_CAP"], fallback: String(SESSION_CAP_MAX) })
      .then(setSessionCap)
      .catch(() => setSessionCap(String(SESSION_CAP_MAX)));
  }, [root]);

  async function saveSessionCap(raw: string) {
    if (!root) return;
    const trimmed = raw.trim();
    if (trimmed === "") {
      setSessionCapError(undefined);
      await writeEnvOverride(root, "APLYX_SESSION_CAP", "");
      setSessionCap(String(SESSION_CAP_MAX));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1 || n > SESSION_CAP_MAX) {
      setSessionCapError(`Enter a whole number from 1 to ${SESSION_CAP_MAX}.`);
      return;
    }
    setSessionCapError(undefined);
    setSessionCap(String(n));
    await writeEnvOverride(root, "APLYX_SESSION_CAP", String(n));
  }

  async function selectHarness(harness: string) {
    if (!root || harness === configuredHarness) return;
    const previous = configuredHarness;
    setConfiguredHarness(harness); // optimistic, same pattern as toggleScheduler
    setHarnessBusy(true);
    setHarnessError(undefined);
    try {
      await writeHarness(root, harness);
    } catch (err) {
      setConfiguredHarness(previous);
      setHarnessError(err instanceof Error ? err.message : String(err));
    } finally {
      setHarnessBusy(false);
    }
  }

  async function toggleScheduler() {
    if (!root || !schedulerStatus) return;
    const target = !schedulerStatus.installed;
    const previous = schedulerStatus;
    // Optimistic flip: the switch moves the instant you click, before the
    // backend round-trip even starts: uninstall in particular can take a
    // real several seconds when it has to verify a currently-running
    // scheduled job has actually finished tearing down (not just fire a
    // signal and hope, see scheduler.py's _bootout_and_verify), and with
    // no visual change during that wait a click looked like it did
    // nothing, which is exactly what invited repeated clicking. Rolled
    // back below only if the call actually fails.
    setSchedulerStatus({ ...schedulerStatus, installed: target });
    setSchedulerTarget(target);
    setSchedulerBusy(true);
    setSchedulerError(undefined);
    try {
      const next = await setSchedulerInstalled(root, target);
      setSchedulerStatus(next);
    } catch (err) {
      setSchedulerStatus(previous);
      setSchedulerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulerBusy(false);
      setSchedulerTarget(undefined);
    }
  }

  return (
    <>
      <section className="settings-section">
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Appearance</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div className="field">
            <span className="field-label">Mode</span>
            <div className="yesno-toggle" role="group" aria-label="Mode">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={theme === opt.value ? "selected" : ""}
                  title={opt.detail}
                  onClick={() => setTheme(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="field-help">System follows your OS and switches automatically; Light/Dark pin it.</p>
          </div>
          {root && (
            <div className="field">
              <span className="field-label">Motion</span>
              <div className="yesno-toggle" role="group" aria-label="Motion">
                <button type="button" className={!reducedMotion ? "selected" : ""} onClick={() => setReducedMotion(false)}>
                  Normal
                </button>
                <button type="button" className={reducedMotion ? "selected" : ""} onClick={() => setReducedMotion(true)}>
                  Reduced
                </button>
              </div>
              <p className="field-help">
                Reduced turns off entrance/hover animations, the recommended-jobs marquee scroll, and
                other cycling motion app-wide, leaving plain state changes instead.
              </p>
            </div>
          )}
        </div>
      </section>

      {(root || status === "signed-in") && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Coding agent</h2>

          {status === "signed-in" && (
            <div className="field" style={{ marginBottom: "var(--space-4)" }}>
              <span className="field-label">Execution</span>
              <div className="yesno-toggle" role="group" aria-label="Execution mode">
                <button
                  type="button"
                  className={executionMode === "byok" ? "selected" : ""}
                  onClick={() => setExecutionMode("byok")}
                >
                  Bring your own agent
                </button>
                <button
                  type="button"
                  className={executionMode === "hosted" ? "selected" : ""}
                  onClick={() => setExecutionMode("hosted")}
                >
                  Hosted plan
                </button>
              </div>
              <p className="field-help">
                {executionMode === "byok"
                  ? "Runs use the coding agent installed on this machine: nothing routes through aplyx's servers."
                  : "aplyx runs the agent for you on hosted infrastructure. No local install or API key needed."}
              </p>
            </div>
          )}

          {(executionMode === "byok" || status !== "signed-in") &&
            (root ? (
              <>
                {detectedHarnesses === undefined ? (
                  <p className="field-help">Looking for a coding agent on this machine…</p>
                ) : detectedHarnesses.length === 0 ? (
                  <p className="field-help">
                    No supported coding agent (opencode, Claude Code, Codex, or GitHub Copilot) was
                    found on this machine. Install one, then reopen Settings.
                  </p>
                ) : (
                  <HarnessPicker
                    options={detectedHarnesses}
                    selected={configuredHarness}
                    onSelect={(h) => void selectHarness(h)}
                    disabled={harnessBusy}
                  />
                )}
                {harnessError ? <p className="field-help" style={{ color: "var(--danger)" }}>{harnessError}</p> : null}
              </>
            ) : (
              <p className="field-help">
                Connect a local install in Account to choose which coding agent drives your runs.
              </p>
            ))}

          {status === "signed-in" && executionMode === "hosted" && (
            <div className="check-row">
              <span className="check-icon check-icon-pending">–</span>
              <div style={{ flex: 1 }}>
                <div className="check-label">Hosted plan (coming soon)</div>
                <div className="check-detail">
                  Fully managed runs (no local install, no coding agent to install or pay for
                  separately) aren't live yet. Stick with "Bring your own agent" for now.
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {root && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Discord notifications</h2>
          <DiscordSettings root={root} />
        </section>
      )}

      {/* Local-install-scoped like Discord/Run defaults above: the
       * extension talks to a localhost bridge reading this install's own
       * config, so it means nothing without root. Chrome extensions have
       * no scriptable install path (only chrome://extensions or the
       * Chrome Web Store can enable one; see docs/SETUP.md §2.6's note on
       * this), so this section links out to the full walkthrough instead
       * of duplicating it a fourth place (already on aplyx.app/
       * extension.html, aplyx.app/install.html#extension, and
       * docs/SETUP.md). */}
      {root && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Browser extension</h2>
          <p className="field-help">
            A Chrome extension for manual, browser-driven applications: it notices a real
            application form on Greenhouse, Lever, Ashby, or Workday, asks before doing anything,
            and autofills it from this profile; you still review every field and click submit
            yourself. The installer already built it (
            <code style={CODE_STYLE}>src/extension/dist/</code>); loading it into Chrome is a
            manual step Chrome itself requires.
          </p>
          <button
            type="button"
            className="settings-action-btn"
            onClick={() => void openUrl("https://aplyx.app/extension.html")}
          >
            View setup instructions
          </button>
        </section>
      )}

      {root && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Run defaults</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <div className="field">
              <label className="field-label" htmlFor="session-cap">
                Session cap
              </label>
              <input
                id="session-cap"
                type="text"
                inputMode="numeric"
                placeholder={String(SESSION_CAP_MAX)}
                value={sessionCap}
                onChange={(e) => setSessionCap(e.currentTarget.value)}
                onBlur={(e) => void saveSessionCap(e.currentTarget.value)}
                style={{ maxWidth: "6rem" }}
              />
              <p className="field-help">
                Default applications-per-run cap, 1–{SESSION_CAP_MAX}. A run may lower this further; it
                can never raise it past {SESSION_CAP_MAX}.
              </p>
              {sessionCapError ? <p className="field-help" style={{ color: "var(--danger)" }}>{sessionCapError}</p> : null}
            </div>
            <div className="field">
              <span className="field-label">Clock</span>
              <div className="yesno-toggle" role="group" aria-label="Clock format">
                <button type="button" className={!hour24Clock ? "selected" : ""} onClick={() => setHour24Clock(false)}>
                  12-hour
                </button>
                <button type="button" className={hour24Clock ? "selected" : ""} onClick={() => setHour24Clock(true)}>
                  24-hour
                </button>
              </div>
              <p className="field-help">Switches the Home screen clock between 2:30 PM and 14:30 style.</p>
            </div>
          </div>
        </section>
      )}

      {root && schedulerStatus && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Scheduler</h2>
          <div className="check-row">
            <div style={{ flex: 1 }}>
              <div className="check-label">
                {schedulerBusy
                  ? schedulerTarget
                    ? "Starting…"
                    : "Stopping current run…"
                  : schedulerStatus.installed
                    ? `Scanning every ${schedulerStatus.interval_min} min`
                    : "Not running"}
              </div>
              <div className="check-detail">
                {schedulerBusy
                  ? schedulerTarget
                    ? "Registering the background schedule."
                    : "Waiting for a live run to finish exiting (can take a few seconds)."
                  : schedulerStatus.installed
                    ? "aplyx checks the job boards for new postings every 30 minutes in the background, keeping your dashboard fresh."
                    : "Recommended: keep this on so aplyx keeps finding new jobs for you every 30 minutes."}
              </div>
            </div>
            <Switch
              checked={schedulerStatus.installed}
              onChange={() => void toggleScheduler()}
              disabled={schedulerBusy}
              label="Background job scanning"
            />
          </div>
          {schedulerError ? <p className="field-help" style={{ color: "var(--danger)" }}>{schedulerError}</p> : null}

          <div className="check-row" style={{ marginTop: "var(--space-3)" }}>
            <div style={{ flex: 1 }}>
              <div className="check-label">Auto-apply on a schedule</div>
              <div className="check-detail">
                {scheduledAutoApply
                  ? "Scheduled runs also tailor a resume and submit applications, up to your session cap. Anything it can't fill confidently still goes to the review queue."
                  : "Off: scheduled runs only find and rank jobs. You apply from the review queue, or with Run now. Turning this on lets the background schedule submit applications unattended."}
              </div>
            </div>
            <Switch
              checked={scheduledAutoApply}
              onChange={setScheduledAutoApply}
              label="Auto-apply on a schedule"
            />
          </div>

          <p className="field-help">
            Run now (on the Run screen) always applies, regardless of this setting. The scheduler toggle
            also works from the terminal:{" "}
            <code style={CODE_STYLE}>python3 src/scripts/runtime/scheduler.py install</code> /{" "}
            <code style={CODE_STYLE}>uninstall</code> /{" "}
            <code style={CODE_STYLE}>status</code>.
          </p>
        </section>
      )}
    </>
  );
}
