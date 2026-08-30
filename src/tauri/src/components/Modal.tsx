import { useEffect, useState, type ReactNode } from "react";
import "./Modal.css";

/**
 * Centered overlay — JobsScreen's job-detail view (was a side .detail-col;
 * now full posting content, description included, needs real room).
 * transform-origin stays center deliberately (unlike Dropdown/NavMenu's
 * trigger-anchored popovers, or Status's bottom sheet): a modal isn't
 * anchored to whichever row you clicked, it's the same centered dialog
 * regardless of where that row sits in a scrolled list.
 */
export function Modal({
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
  // Separate from `everOpened`: the very first time this modal ever
  // mounts, inserting it straight into the DOM with modal-open already
  // applied gives the CSS transition nothing to animate FROM (a
  // brand-new element just renders at its final computed style, no
  // matter what transition is declared on it) — the popup would snap
  // open with no visible motion. Mounting closed first, then flipping to
  // open a frame later, gives the transition a real starting frame.
  // Every subsequent open/close toggles this same already-mounted
  // element, which transitions correctly on its own.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    setEverOpened(true);
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
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
      <div className={`modal-backdrop${visible ? " modal-backdrop-open" : ""}`} onClick={onClose} aria-hidden="true" />
      <div
        className={`modal${visible ? " modal-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-hidden={!visible}
      >
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
    </>
  );
}
