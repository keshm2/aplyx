import "./Skeleton.css";

/** One shimmering stand-in for a `.data-row` (Jobs/Review/Status/Resumes/
 *  Documents' list rows) — same box, so nothing jumps when the real row
 *  swaps in. Width varies slightly per index so a run of rows doesn't
 *  read as a mechanically repeated tile. */
function SkeletonRow({ index }: { index: number }) {
  return (
    <div className="data-row skeleton-row">
      <div className="data-row-main">
        <span className="skeleton skeleton-line" style={{ width: `${62 - (index % 3) * 6}%` }} />
        <span className="skeleton skeleton-line skeleton-line-sm" style={{ width: "38%" }} />
      </div>
      <span className="skeleton skeleton-badge" />
    </div>
  );
}

/** A full `.data-list` of skeleton rows — drop-in replacement for a plain
 *  "Loading…" string wherever a screen is waiting on its first data. The
 *  sr-only status lives outside the aria-hidden visual block so a screen
 *  reader hears one clear "Loading" instead of reading through empty bars. */
export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        Loading…
      </span>
      <div className="data-list" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <SkeletonRow key={i} index={i} />
        ))}
      </div>
    </>
  );
}

/** Stand-in for Home's three `.home-stat-card`s while the local install's
 *  state is still loading. */
export function SkeletonStatCards() {
  return (
    <div className="home-stats" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="home-stat-card skeleton-row">
          <span className="skeleton skeleton-line" style={{ width: "2.5rem", height: "1.8rem" }} />
          <span className="skeleton skeleton-line skeleton-line-sm" style={{ width: "70%" }} />
        </div>
      ))}
    </div>
  );
}

/** Stand-in for Home's `.home-next` "what's next" card. */
export function SkeletonNextCard() {
  return (
    <div className="home-next skeleton-row" aria-hidden="true">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", flex: 1 }}>
        <span className="skeleton skeleton-line" style={{ width: "45%", height: "1.1em" }} />
        <span className="skeleton skeleton-line skeleton-line-sm" style={{ width: "80%" }} />
      </div>
      <span className="skeleton" style={{ width: "8rem", height: "2.2rem", borderRadius: "var(--radius-md)", flexShrink: 0 }} />
    </div>
  );
}
