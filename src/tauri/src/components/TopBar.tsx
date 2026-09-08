import { useEffect, useRef, useState } from "react";
import { NotificationBell } from "./NotificationBell";
import "./TopBar.css";

/** Sticky glass strip above every screen's own content: the bell needs to
 *  be reachable from anywhere, not just Home, so this lives in AppShell
 *  rather than any individual screen. Logo + primary nav + Settings all
 *  moved out to the persistent Sidebar (2026-09-08, Settings pinned at its
 *  bottom like Shopify/Slack/Linear); this bar is now scroll-edge chrome
 *  and the bell only, entirely to the right of the sidebar, so it no
 *  longer needs the macOS traffic-light clearance it used to own (the
 *  sidebar sits under those buttons now, this bar doesn't). */
export function TopBar() {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // Toggle the scroll-edge floor shadow only once content is actually
  // scrolled up behind the sticky bar.
  useEffect(() => {
    const scroller = ref.current?.closest(".shell-main");
    if (!scroller) return;
    const onScroll = () => setScrolled(scroller.scrollTop > 4);
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="topbar" ref={ref} data-scrolled={scrolled}>
      <div className="topbar-right">
        <NotificationBell />
      </div>
    </div>
  );
}
