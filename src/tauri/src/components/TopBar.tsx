import { Logo } from "./Logo";
import { NavMenu, type NavMenuItem } from "./NavMenu";
import { NotificationBell, SettingsGearButton } from "./NotificationBell";
import "./TopBar.css";

/** Persistent header row above every screen's own content — the bell and
 *  gear both need to be reachable from anywhere, not just Home, so this
 *  lives in AppShell rather than any individual screen. Settings used to
 *  be its own sidebar nav entry; it's the gear here now instead, next to
 *  the bell, per the operator's explicit call — nothing about what
 *  Settings shows changed, only how it's reached. Logo + NavMenu moved
 *  here from the old persistent sidebar rail (replaced with a dropdown so
 *  every screen's content gets the full window width instead of a fixed
 *  reserved column). */
export function TopBar({ navItems, queueBadge }: { navItems: NavMenuItem[]; queueBadge?: { to: string; count: number } }) {
  return (
    <div className="topbar">
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
