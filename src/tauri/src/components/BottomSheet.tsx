import { useEffect, useState, type ReactNode } from "react";
import "./BottomSheet.css";

/**
 * A sheet that slides up from the bottom, not a side detail panel —
 * StatusScreen's online-application detail view specifically (the local
 * side never gets this; see StatusScreen.tsx). Kept mounted after first
 * open (same pattern as Dropdown.tsx/NotificationBell) so closing plays a
 * real slide-down exit instead of vanishing the instant the caller sets
 * open=false.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const [everOpened, setEverOpened] = useState(false);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!everOpened) return null;

  return (
    <>
      <div
        className={`bottom-sheet-backdrop${open ? " bottom-sheet-backdrop-open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`bottom-sheet${open ? " bottom-sheet-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-hidden={!open}
      >
        <div className="bottom-sheet-header">
          <button type="button" className="bottom-sheet-back" onClick={onClose} aria-label="Back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <span className="bottom-sheet-title">{title}</span>
        </div>
        <div className="bottom-sheet-content">{children}</div>
      </div>
    </>
  );
}
