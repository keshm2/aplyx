import { type ComponentType } from "react";
import { NavLink } from "react-router-dom";
import { Logo } from "./Logo";
import "./Sidebar.css";

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  Icon: ComponentType;
}

export interface ActivityStatus {
  label: string;
  detail: string;
  tone: "good" | "warn" | "muted" | "info";
  to: string;
}

/**
 * Persistent left nav rail (operator request, 2026-09-08, referencing a
 * Shopify-admin-style dashboard): every destination visible and reachable
 * in one glance, replacing the dropdown-trigger nav (NavMenu.tsx, removed)
 * that traded that away for a few extra pixels of content width. A fixed
 * fixed-width column costs real estate but answers "where am I, where can
 * I go" without a click, which a hidden-until-opened menu can't.
 *
 * Owns the macOS traffic-light clearance on its own (padding-top): it's
 * the only thing that actually sits under the overlay title bar's
 * top-left buttons (tauri.conf.json's titleBarStyle: Overlay); TopBar,
 * now entirely to the right of this column, no longer needs that
 * clearance itself.
 *
 * Two lower sections mirror Shopify's own grouping (a labeled secondary
 * group below the main nav, settings pinned at the very bottom): ACTIVITY
 * surfaces the scheduler/run state that otherwise only lives on Home
 * (SchedulerStatusCard) or Run itself, so "is it actually working" stays
 * answerable from any screen. Replaced an earlier connection-status
 * version (local install / hosted account, always the same two dots)
 * that read as decoration rather than something worth a glance.
 */
export function Sidebar({
  items,
  queueBadge,
  activity,
  settingsItem,
}: {
  items: NavItem[];
  /** Live count shown on whichever item's `to` matches (see AppShell's
   *  review-queue count) — same badge convention the old NavMenu used. */
  queueBadge?: { to: string; count: number };
  activity?: ActivityStatus[];
  settingsItem: NavItem;
}) {
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-brand">
        <Logo size={26} />
      </div>

      <div className="sidebar-nav">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? "sidebar-item sidebar-item-active" : "sidebar-item")}
          >
            <item.Icon />
            <span className="sidebar-item-label">{item.label}</span>
            {queueBadge && item.to === queueBadge.to && queueBadge.count > 0 && (
              <span className="sidebar-badge" aria-label={`${queueBadge.count} waiting for review`}>
                {queueBadge.count > 99 ? "99+" : queueBadge.count}
              </span>
            )}
          </NavLink>
        ))}
      </div>

      {activity && activity.length > 0 && (
        <div className="sidebar-group">
          <span className="sidebar-group-label">Activity</span>
          {activity.map((a) => (
            <NavLink key={a.label} to={a.to} className="sidebar-item sidebar-activity-row">
              <span className={`sidebar-dot sidebar-dot-${a.tone}`} aria-hidden="true" />
              <span className="sidebar-activity-text">
                <span className="sidebar-item-label">{a.label}</span>
                <span className="sidebar-activity-detail">{a.detail}</span>
              </span>
            </NavLink>
          ))}
        </div>
      )}

      <div className="sidebar-footer">
        <NavLink
          to={settingsItem.to}
          className={({ isActive }) => (isActive ? "sidebar-item sidebar-item-active" : "sidebar-item")}
        >
          <settingsItem.Icon />
          <span className="sidebar-item-label">{settingsItem.label}</span>
        </NavLink>
      </div>
    </nav>
  );
}
