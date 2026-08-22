import { useId, useMemo, useState } from "react";
import type { AppliedJob } from "@aplyx/core/state.js";
import "./WeeklyActivityChart.css";

const DAYS = 14;
const VIEW_W = 560;
const VIEW_H = 160;
const PAD_X = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

interface DayPoint {
  date: string; // YYYY-MM-DD
  label: string; // short weekday, e.g. "Mon"
  count: number;
}

/** Applications sent per day for the last DAYS days (oldest first), derived
 *  entirely from state.applied — no bridge call needed, the data's already
 *  loaded. Days with zero applications are included (not skipped), so a
 *  quiet stretch reads as a real dip in the line, not a gap. */
function computeDailyActivity(applied: AppliedJob[], days: number): DayPoint[] {
  const counts = new Map<string, number>();
  for (const job of applied) {
    const date = (job.date_applied ?? "").slice(0, 10);
    if (!date) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const points: DayPoint[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    points.push({
      date: iso,
      label: d.toLocaleDateString(undefined, { weekday: "short" }),
      count: counts.get(iso) ?? 0,
    });
  }
  return points;
}

/** Catmull-Rom -> cubic Bezier conversion (tension 1/6) — the standard way
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

export function WeeklyActivityChart({ applied }: { applied: AppliedJob[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Unique per mount so two instances of this chart on the same page (not
  // currently the case, but SVG gradient ids are global) never collide.
  const gradientId = useId();

  const points = useMemo(() => computeDailyActivity(applied, DAYS), [applied]);
  const maxCount = Math.max(1, ...points.map((p) => p.count));

  const plotW = VIEW_W - PAD_X * 2;
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const coords = points.map((p, i) => ({
    x: PAD_X + (i / (points.length - 1)) * plotW,
    y: PAD_TOP + plotH - (p.count / maxCount) * plotH,
  }));

  const linePath = smoothPath(coords);
  const areaPath = `${linePath} L ${coords[coords.length - 1].x},${PAD_TOP + plotH} L ${coords[0].x},${PAD_TOP + plotH} Z`;

  // Sparse x-axis labels — every ~3rd day plus the last, so 14 labels never
  // collide into an unreadable row.
  const labelStep = Math.ceil(points.length / 5);

  const total = points.reduce((sum, p) => sum + p.count, 0);

  return (
    <div className="activity-chart">
      <div className="activity-chart-header">
        <h2 className="activity-chart-title">Weekly activity</h2>
        <span className="activity-chart-total">{total} sent in the last {DAYS} days</span>
      </div>
      <svg
        className="activity-chart-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Applications sent per day over the last ${DAYS} days, totaling ${total}`}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Prism's three-stop identity (violet → cyan → magenta), applied
           here instead of a flat --accent fill — the one other place
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

        {/* Recessive reference lines — just enough to anchor the eye, not a full grid. */}
        {[0, 0.5, 1].map((t) => (
          <line
            key={t}
            className="activity-chart-gridline"
            x1={PAD_X}
            x2={VIEW_W - PAD_X}
            y1={PAD_TOP + plotH * t}
            y2={PAD_TOP + plotH * t}
          />
        ))}

        <path className="activity-chart-area" d={areaPath} fill={`url(#${gradientId})`} />
        <path className="activity-chart-line" d={linePath} pathLength={1} stroke={`url(#${gradientId})`} />

        {hoverIndex !== null && (
          <line
            className="activity-chart-crosshair"
            x1={coords[hoverIndex].x}
            x2={coords[hoverIndex].x}
            y1={PAD_TOP}
            y2={PAD_TOP + plotH}
          />
        )}

        {coords.map((c, i) => (
          <circle
            key={points[i].date}
            className={`activity-chart-dot${hoverIndex === i ? " activity-chart-dot-active" : ""}`}
            cx={c.x}
            cy={c.y}
            r={hoverIndex === i ? 4 : 2.5}
          />
        ))}

        {/* Hit targets bigger than the visible dots, one per day. */}
        {coords.map((c, i) => (
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
            <text key={p.date} className="activity-chart-axis-label" x={coords[i].x} y={VIEW_H - 8} textAnchor="middle">
              {p.label}
            </text>
          ) : null,
        )}
      </svg>

      {hoverIndex !== null && (
        <div
          className="activity-chart-tooltip"
          style={{ left: `${(coords[hoverIndex].x / VIEW_W) * 100}%` }}
        >
          <strong>{points[hoverIndex].count}</strong> on{" "}
          {new Date(points[hoverIndex].date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </div>
      )}
    </div>
  );
}
