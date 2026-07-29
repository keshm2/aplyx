import { NotificationBell, SettingsGearButton } from "./NotificationBell";
import "./TopBar.css";

/** Persistent header row above every screen's own content — the bell and
 *  gear both need to be reachable from anywhere, not just Home, so this
 *  lives in AppShell rather than any individual screen. Settings used to
 *  be its own sidebar nav entry; it's the gear here now instead, next to
 *  the bell, per the operator's explicit call — nothing about what
 *  Settings shows changed, only how it's reached. */
export function TopBar() {
  return (
    <div className="topbar">
      <NotificationBell />
      <SettingsGearButton />
    </div>
  );
}
