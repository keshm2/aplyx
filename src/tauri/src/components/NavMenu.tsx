import { useEffect, useRef, useState, type ComponentType } from "react";
import { NavLink, useLocation } from "react-router-dom";
import "./NavMenu.css";

export interface NavMenuItem {
  to: string;
  label: string;
  end?: boolean;
  Icon: ComponentType;
}

/**
 * Replaces the old persistent sidebar rail: a single trigger (current
 * screen's icon + label) that opens a dropdown listing every destination,
 * same open/close mechanics as Dropdown.tsx/NotificationBell (mount-once
 * after first open so closing plays a real exit transition, outside-click
 * + Escape to dismiss, closes itself once navigation actually lands rather
 * than needing each item to call back into this component).
 */
export function NavMenu({
  items,
  queueBadge,
}: {
  items: NavMenuItem[];
  /** Live count shown on whichever item's `to` matches — see AppShell's
   *  review-queue count. Also surfaces as a small dot on the trigger
   *  itself when that item isn't the one currently active, so "something
   *  needs review" is still visible with the menu closed. */
  queueBadge?: { to: string; count: number };
}) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  const active =
    items.find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to))) ??
    items[0];

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

  // Clicking an item navigates, which changes location.pathname — that's
  // the signal to close, rather than every item needing its own onClick.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const dotOnTrigger = queueBadge && queueBadge.count > 0 && active.to !== queueBadge.to;

  return (
    <div className="nav-menu-root" ref={rootRef}>
      <button
        type="button"
        className="nav-menu-trigger"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Navigate — currently on ${active.label}`}
      >
        <active.Icon />
        <span className="nav-menu-trigger-label">{active.label}</span>
        {dotOnTrigger && <span className="nav-menu-trigger-dot" aria-hidden="true" />}
        <svg
          className="nav-menu-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {everOpened && (
        <div className={`nav-menu-panel${open ? " nav-menu-panel-open" : ""}`} role="menu" aria-hidden={!open}>
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              role="menuitem"
              className={({ isActive }) => (isActive ? "nav-menu-item nav-menu-item-active" : "nav-menu-item")}
            >
              <item.Icon />
              <span className="nav-menu-item-label">{item.label}</span>
              {queueBadge && item.to === queueBadge.to && queueBadge.count > 0 && (
                <span className="nav-menu-badge" aria-label={`${queueBadge.count} waiting for review`}>
                  {queueBadge.count > 99 ? "99+" : queueBadge.count}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
