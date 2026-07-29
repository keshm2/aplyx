import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useNotifications, type NotificationItem, type NotificationTab } from "../lib/notifications";
import "./NotificationBell.css";

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function BellIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function CheckAllIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 12 5 5L18 7" />
      <path d="m9 16 2 2L21 8" />
    </svg>
  );
}

const SEVERITY_GLYPH: Record<NotificationItem["severity"], string> = {
  critical: "!",
  warn: "•",
  good: "✓",
  info: "i",
};

function NotificationRow({
  item,
  read,
  onHoverRead,
}: {
  item: NotificationItem;
  read: boolean;
  onHoverRead: (id: string) => void;
}) {
  return (
    <div
      className={`notif-row${read ? "" : " notif-row-unread"}${item.severity === "critical" && !read ? " notif-row-critical" : ""}`}
      onMouseEnter={() => onHoverRead(item.id)}
    >
      <span className={`notif-icon notif-icon-${item.severity}`} aria-hidden="true">
        {SEVERITY_GLYPH[item.severity]}
      </span>
      <div className="notif-body">
        <div className="notif-row-top">
          <span className="notif-title">{item.title}</span>
          {!read && <span className="notif-dot" aria-label="unread" />}
        </div>
        {item.detail && item.detail.length > 0 && (
          <div className="notif-detail">
            {item.detail.length === 1 ? (
              <span>{item.detail[0]}</span>
            ) : (
              <ul>
                {item.detail.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <span className="notif-time">{relativeTime(item.timestamp)}</span>
      </div>
    </div>
  );
}

/** Bell icon + unread badge + dropdown (General / Jobs tabs). Notification
 *  read state: hovering a row marks it read immediately (no click
 *  required — per spec, "a notification can be considered read if the
 *  user just hovers their mouse over it"). Critical items (a failed
 *  application) get a gently flashing pastel-red treatment while unread,
 *  same visual language a "needs attention now" toast would use elsewhere,
 *  and stop animating the moment they're read. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  // Keeps the dropdown mounted after its first open so closing it can
  // play a real exit transition (opacity/transform/visibility, all
  // CSS-driven — see .notif-dropdown / .notif-dropdown-open) instead of
  // just vanishing the instant `open` flips false, the way a plain
  // `{open && <div>}` mount/unmount would. Never rendered at all until
  // the first click, so a session that never opens it pays nothing.
  const [everOpened, setEverOpened] = useState(false);
  const [tab, setTab] = useState<NotificationTab>("general");
  const location = useLocation();
  const { items, isRead, markRead, markAllRead, unreadCount } = useNotifications(location.pathname);
  const rootRef = useRef<HTMLDivElement>(null);

  function toggleOpen() {
    setOpen((o) => {
      const next = !o;
      if (next) setEverOpened(true);
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const total = unreadCount();
  const shown = items.filter((i) => i.tab === tab);

  return (
    <div className="notif-root" ref={rootRef}>
      <button
        type="button"
        className="notif-bell-btn"
        aria-label={total > 0 ? `Notifications, ${total} unread` : "Notifications"}
        onClick={toggleOpen}
      >
        <BellIcon />
        {total > 0 && <span className="notif-badge">{total > 99 ? "99+" : total}</span>}
      </button>

      {everOpened && (
        <div
          className={`notif-dropdown${open ? " notif-dropdown-open" : ""}`}
          role="dialog"
          aria-label="Notifications"
          aria-hidden={!open}
        >
          <div className="notif-header">
            <h2>Notifications</h2>
            <button
              type="button"
              className="notif-icon-btn"
              title="Mark all as read"
              aria-label="Mark all as read"
              onClick={() => markAllRead(tab)}
            >
              <CheckAllIcon />
            </button>
          </div>

          <div className="notif-tabs" role="tablist">
            {(["general", "jobs"] as const).map((t) => {
              const count = unreadCount(t);
              return (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? "notif-tab notif-tab-active" : "notif-tab"}
                  onClick={() => setTab(t)}
                >
                  {t === "general" ? "General" : "Jobs"}
                  {count > 0 ? ` (${count})` : ""}
                </button>
              );
            })}
          </div>

          <div className="notif-list">
            {shown.length === 0 ? (
              <p className="notif-empty">Nothing here yet.</p>
            ) : (
              shown.map((item) => (
                <NotificationRow key={item.id} item={item} read={isRead(item.id)} onHoverRead={markRead} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsGearButton() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="notif-bell-btn settings-gear-btn"
      aria-label="Settings"
      title="Settings"
      onClick={() => navigate("/app/settings")}
    >
      <svg className="settings-gear-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    </button>
  );
}
