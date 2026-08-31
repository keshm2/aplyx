import type { RegistryRecord } from "@aplyx/core/state.js";
import "./PipelineBreakdown.css";

interface StatusSegment {
  key: string;
  label: string;
  count: number;
  colorVar: string;
}

/** How the deterministic fit gate is triaging everything it's scraped:
 *  latest_status is the only per-registry-record signal actually persisted
 *  (job_state.py's ALLOWED_STATUSES); there's no stored "candidate" status
 *  on its own since a candidate immediately becomes applied/failed once
 *  Phase 3 runs, or stays new/seen if this run hasn't reached it yet. This
 *  is a status (state) color job, not categorical identity, so it reuses
 *  this app's existing status tokens (--good/--warn/--danger) rather than
 *  a separate categorical palette. */
function computeBreakdown(registry: RegistryRecord[]): StatusSegment[] {
  const counts = { applied: 0, needs_review: 0, failed: 0, skipped_unfit: 0, pending: 0 };
  for (const rec of registry) {
    const status = rec.latest_status ?? "";
    if (status === "applied") counts.applied++;
    else if (status === "needs_review") counts.needs_review++;
    else if (status === "failed") counts.failed++;
    else if (status === "skipped_unfit") counts.skipped_unfit++;
    else counts.pending++; // "new" | "seen" | anything unrecognized
  }
  return [
    { key: "applied", label: "Applied", count: counts.applied, colorVar: "--good" },
    { key: "needs_review", label: "Needs review", count: counts.needs_review, colorVar: "--warn" },
    { key: "failed", label: "Failed", count: counts.failed, colorVar: "--danger" },
    { key: "skipped_unfit", label: "Not a fit", count: counts.skipped_unfit, colorVar: "--text-faint" },
    { key: "pending", label: "Not yet triaged", count: counts.pending, colorVar: "--accent" },
  ];
}

export function PipelineBreakdown({ registry }: { registry: RegistryRecord[] }) {
  const segments = computeBreakdown(registry);
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  const nonEmpty = segments.filter((s) => s.count > 0);

  return (
    <div className="pipeline-breakdown">
      <h2 className="pipeline-breakdown-title">Pipeline breakdown</h2>
      <p className="pipeline-breakdown-subtitle">{total} jobs seen, how the fit gate triaged them</p>

      {total === 0 ? (
        <p className="field-help">Nothing scraped yet.</p>
      ) : (
        <>
          <div className="pipeline-breakdown-bar" role="img" aria-label={nonEmpty.map((s) => `${s.label}: ${s.count}`).join(", ")}>
            {nonEmpty.map((s) => (
              <span
                key={s.key}
                className="pipeline-breakdown-segment"
                style={{ width: `${(s.count / total) * 100}%`, backgroundColor: `var(${s.colorVar})` }}
              />
            ))}
          </div>
          <ul className="pipeline-breakdown-legend">
            {nonEmpty.map((s) => (
              <li key={s.key}>
                <span className="pipeline-breakdown-swatch" style={{ backgroundColor: `var(${s.colorVar})` }} aria-hidden="true" />
                <span className="pipeline-breakdown-label">{s.label}</span>
                <span className="pipeline-breakdown-count">{s.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
