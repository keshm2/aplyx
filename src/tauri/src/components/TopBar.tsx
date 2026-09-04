import { useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { NavMenu, type NavMenuItem } from "./NavMenu";
import { NotificationBell, SettingsGearButton } from "./NotificationBell";
import "./TopBar.css";

/** Persistent header row above every screen's own content: the bell and
 *  gear both need to be reachable from anywhere, not just Home, so this
 *  lives in AppShell rather than any individual screen. Settings used to
 *  be its own sidebar nav entry; it's the gear here now instead, next to
 *  the bell, per the operator's explicit call; nothing about what
 *  Settings shows changed, only how it's reached. Logo + NavMenu moved
 *  here from the old persistent sidebar rail (replaced with a dropdown so
 *  every screen's content gets the full window width instead of a fixed
 *  reserved column). */
export function TopBar({ navItems, queueBadge }: { navItems: NavMenuItem[]; queueBadge?: { to: string; count: number } }) {
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
      <div className="topbar-left">
        <Logo size={22} withWordmark={false} />
        <NavMenu items={navItems} queueBadge={queueBadge} />
      </div>
      <div className="topbar-right">
        <NotificationBell />
        <SettingsGearButton />
      </div>
    </div>
  );
}
