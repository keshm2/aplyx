import { useEffect, useState } from "react";
import { getSchedulerStatus, setSchedulerInstalled, type SchedulerStatus } from "../../../lib/bridge";
import { Switch } from "../../../components/Switch";
import "../../../components/formFields.css";

/** Finish step. Also the one place onboarding offers the background job
 *  scanner: a new user should leave setup with aplyx already watching the
 *  boards for them, so it's opt-out here rather than buried in Settings.
 *  Applying on a schedule stays off by default (Settings › Preferences ›
 *  Auto-apply on a schedule); this only installs the 30-minute scan. */
export function ReviewStep({ root }: { root: string }) {
  const [scheduler, setScheduler] = useState<SchedulerStatus | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getSchedulerStatus(root)
      .then((s) => {
        if (!cancelled) setScheduler(s);
      })
      .catch(() => {
        if (!cancelled) setScheduler(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  async function toggle() {
    if (!scheduler) return;
    const target = !scheduler.installed;
    const previous = scheduler;
    setScheduler({ ...scheduler, installed: target });
    setBusy(true);
    setError(undefined);
    try {
      setScheduler(await setSchedulerInstalled(root, target));
    } catch (err) {
      setScheduler(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <p>
        That&rsquo;s everything aplyx needs to get started. You can revisit any of this later from
        Settings; nothing here is final.
      </p>

      {scheduler?.supported && (
        <div className="check-row">
          <div style={{ flex: 1 }}>
            <div className="check-label">Keep scanning for new jobs</div>
            <div className="check-detail">
              Recommended. aplyx checks the job boards every 30 minutes in the background so new
              matches are waiting for you. It won&rsquo;t apply to anything on its own &mdash;
              turn on &ldquo;Auto-apply on a schedule&rdquo; in Settings for that.
            </div>
            {error ? <p className="field-help" style={{ color: "var(--danger)" }}>{error}</p> : null}
          </div>
          <Switch
            checked={scheduler.installed}
            onChange={() => void toggle()}
            disabled={busy}
            label="Keep scanning for new jobs"
          />
        </div>
      )}
    </div>
  );
}
