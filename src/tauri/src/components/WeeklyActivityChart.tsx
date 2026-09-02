import { useId, useMemo, useState } from "react";
import type { AppliedJob } from "@aplyx/core/state.js";
import "./WeeklyActivityChart.css";

const DAYS = 14;
const VIEW_W = 560;
const PAD_X = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
/** Left gutter reserved for y-axis tick labels: only allocated when
 *  logScale is on, since the linear chart (Home) never drew them and
 *  shouldn't suddenly gain a left margin. */
const PAD_LEFT_AXIS = 22;

interface DayPoint {
  date: string; // YYYY-MM-DD
  label: string; // short weekday, e.g. "Mon"
  sent: number; // applications sent that day
  cumulative: number; // running total of sent, within the window
}

/** Per-day "applications sent" plus its running total, for the last
 *  `days` days (oldest first), derived entirely from state.applied. Days
 *  with zero applications are included (not skipped), so a quiet stretch
 *  reads as a real flat stretch, not a gap. */
function computeSeries(applied: AppliedJob[], days: number): DayPoint[] {
  const counts = new Map<string, number>();
  for (const job of applied) {
    const date = (job.date_applied ?? "").slice(0, 10);
    if (!date) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const points: DayPoint[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let running = 0;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const sent = counts.get(iso) ?? 0;
    running += sent;
    points.push({
      date: iso,
      label: d.toLocaleDateString(undefined, { weekday: "short" }),
      sent,
      cumulative: running,
    });
  }
  return points;
}

/** Catmull-Rom -> cubic Bezier conversion (tension 1/6): the standard way
 *  to draw a smooth curve through a set of points without overshoot, rather
 *  than straight line-segments between them (a plain polyline is exactly
 *  the "static/slanted" look this chart is meant to avoid). */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x},${points[0].y}`;
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

/** "Nice" whole tick values from a sparse 1/2/5 ladder, spanning up to
 *  domainMax, thinned by `minGap` (px) so labels near the log-compressed
 *  top don't overprint. Always keeps 0; the highest label may sit just
 *  below the chart's true top (where the data still plots) rather than
 *  forcing an odd exact-max label like "21". `place` maps a value to its
 *  y-pixel. A ladder (not evenly-spaced steps) keeps every label a round,
 *  recognizable number after the log transform squeezes them together. */
function pickTicks(domainMax: number, place: (v: number) => number, minGap: number): number[] {
  const ladder = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  const candidates = [0, ...ladder.filter((v) => v <= domainMax)];
  const kept: number[] = [];
  let lastY = Infinity;
  for (const v of candidates) {
    const y = place(v);
    if (v !== 0 && Math.abs(y - lastY) < minGap) continue;
    kept.push(v);
    lastY = y;
  }
  return kept;
}

export function WeeklyActivityChart({
  applied,
  cumulative = false,
  compact = false,
  logScale = false,
}: {
  applied: AppliedJob[];
  /** Also plot the running total of applications sent (a much larger,
   *  monotonically rising line) alongside the per-day count. The two have
   *  genuinely different magnitudes — the daily line rarely exceeds a
   *  handful while the total climbs into the dozens — which is exactly
   *  what makes a log y-axis earn its place. */
  cumulative?: boolean;
  /** Shrinks the plot area (Run screen: room for the second line and a
   *  y-axis without the chart dominating the page); Home keeps the
   *  original larger size. */
  compact?: boolean;
  /** Logarithmic y-axis: log(count + 1) so a day with zero events still
   *  has a defined position instead of -Infinity. Draws real tick labels
   *  (0, 1, 2, 5, 10, ...) at their true log positions, so the uneven
   *  spacing between them is the visible proof it's a log scale. */
  logScale?: boolean;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Unique per mount so two instances of this chart on the same page (not
  // currently the case, but SVG gradient ids are global) never collide.
  const gradientId = useId();

  const points = useMemo(() => computeSeries(applied, DAYS), [applied]);
  const showCumulative = cumulative && points.some((p) => p.cumulative > 0);

  const VIEW_H = compact ? 128 : 160;
  const padLeft = logScale ? PAD_X + PAD_LEFT_AXIS : PAD_X;
  const plotW = VIEW_W - padLeft - PAD_X;
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;

  const domainMax = Math.max(
    1,
    ...points.map((p) => p.sent),
    ...(showCumulative ? points.map((p) => p.cumulative) : []),
  );
  const logDomainMax = Math.log(domainMax + 1);

  function scaleY(count: number): number {
    const t = logScale ? Math.log(count + 1) / logDomainMax : count / domainMax;
    return PAD_TOP + plotH - t * plotH;
  }

  const x = (i: number) => padLeft + (i / (points.length - 1)) * plotW;
  const sentCoords = points.map((p, i) => ({ x: x(i), y: scaleY(p.sent) }));
  const cumulativeCoords = showCumulative ? points.map((p, i) => ({ x: x(i), y: scaleY(p.cumulative) })) : [];

  const linePath = smoothPath(sentCoords);
  const areaPath = `${linePath} L ${sentCoords[sentCoords.length - 1].x},${PAD_TOP + plotH} L ${sentCoords[0].x},${PAD_TOP + plotH} Z`;
  const cumulativeLinePath = showCumulative ? smoothPath(cumulativeCoords) : "";

  // Sparse x-axis labels: every ~3rd day plus the last, so 14 labels never
  // collide into an unreadable row.
  const labelStep = Math.ceil(points.length / 5);

  const total = points.reduce((sum, p) => sum + p.sent, 0);
  const ticks = logScale ? pickTicks(domainMax, scaleY, 12) : [];

  return (
    <div className={`activity-chart${compact ? " activity-chart-compact" : ""}`}>
      <div className="activity-chart-header">
        <h2 className="activity-chart-title">Weekly activity</h2>
        {showCumulative ? (
          <div className="activity-chart-legend">
            <span className="activity-chart-legend-item">
              <span className="activity-chart-legend-swatch activity-chart-legend-swatch-a" aria-hidden="true" />
              Per day
            </span>
            <span className="activity-chart-legend-item">
              <span className="activity-chart-legend-swatch activity-chart-legend-swatch-b" aria-hidden="true" />
              Cumulative
            </span>
            {logScale && <span className="activity-chart-legend-note">log scale</span>}
          </div>
        ) : (
          <span className="activity-chart-total">
            {total} sent in the last {DAYS} days{logScale ? " · log scale" : ""}
          </span>
        )}
      </div>
      <svg
        className="activity-chart-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Applications sent per day over the last ${DAYS} days, totaling ${total}${showCumulative ? ", with a cumulative total line" : ""}${logScale ? ", on a logarithmic scale" : ""}`}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Moss's three-stop identity (moss → honey → clay), applied
           here instead of a flat --accent fill: the one other place
           besides the hero card that earns real color, since it's the
           chart a "how's it going" glance actually looks at. Colors live
           in CSS (activity-chart-stop-a/b/c below), not inline, matching
           how every other SVG color in this component is themed. */}
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" className="activity-chart-stop-a" />
            <stop offset="50%" className="activity-chart-stop-b" />
            <stop offset="100%" className="activity-chart-stop-c" />
          </linearGradient>
        </defs>

        {/* Recessive reference lines: plain thirds for the linear chart,
           or one per real tick value (0, 1, 2, 5, 10, ...) once log-scaled,
           since evenly-spaced fractions would no longer land on round
           numbers — and the uneven gaps between these lines are what
           actually shows the axis is logarithmic. */}
        {(logScale ? ticks.map((v) => scaleY(v)) : [PAD_TOP, PAD_TOP + plotH * 0.5, PAD_TOP + plotH]).map((y, i) => (
          <line key={i} className="activity-chart-gridline" x1={padLeft} x2={VIEW_W - PAD_X} y1={y} y2={y} />
        ))}

        {logScale &&
          ticks.map((v) => (
            <text
              key={v}
              className="activity-chart-axis-label activity-chart-axis-label-y"
              x={padLeft - 6}
              y={scaleY(v) + 3}
              textAnchor="end"
            >
              {v}
            </text>
          ))}

        <path className="activity-chart-area" d={areaPath} fill={`url(#${gradientId})`} />
        <path className="activity-chart-line" d={linePath} pathLength={1} stroke={`url(#${gradientId})`} />
        {showCumulative && <path className="activity-chart-line-b" d={cumulativeLinePath} pathLength={1} />}

        {hoverIndex !== null && (
          <line
            className="activity-chart-crosshair"
            x1={sentCoords[hoverIndex].x}
            x2={sentCoords[hoverIndex].x}
            y1={PAD_TOP}
            y2={PAD_TOP + plotH}
          />
        )}

        {sentCoords.map((c, i) => (
          <circle
            key={points[i].date}
            className={`activity-chart-dot${hoverIndex === i ? " activity-chart-dot-active" : ""}`}
            cx={c.x}
            cy={c.y}
            r={hoverIndex === i ? 4 : 2.5}
          />
        ))}
        {showCumulative &&
          cumulativeCoords.map((c, i) => (
            <circle
              key={points[i].date}
              className={`activity-chart-dot-b${hoverIndex === i ? " activity-chart-dot-b-active" : ""}`}
              cx={c.x}
              cy={c.y}
              r={hoverIndex === i ? 4 : 2.5}
            />
          ))}

        {/* Hit targets bigger than the visible dots, one per day. */}
        {sentCoords.map((c, i) => (
          <rect
            key={`hit-${points[i].date}`}
            x={c.x - plotW / points.length / 2}
            y={PAD_TOP}
            width={plotW / points.length}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(i)}
          />
        ))}

        {points.map((p, i) =>
          i % labelStep === 0 || i === points.length - 1 ? (
            <text key={p.date} className="activity-chart-axis-label" x={sentCoords[i].x} y={VIEW_H - 8} textAnchor="middle">
              {p.label}
            </text>
          ) : null,
        )}
      </svg>

      {hoverIndex !== null && (
        <div
          className="activity-chart-tooltip"
          style={{ left: `${(sentCoords[hoverIndex].x / VIEW_W) * 100}%` }}
        >
          <strong>{points[hoverIndex].sent}</strong> sent
          {showCumulative ? (
            <>
              {" "}
              · <strong>{points[hoverIndex].cumulative}</strong> total
            </>
          ) : null}{" "}
          on {new Date(points[hoverIndex].date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </div>
      )}
    </div>
  );
}
