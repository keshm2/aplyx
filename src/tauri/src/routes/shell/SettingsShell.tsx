import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BUILD_MARKER } from "@aplyx/core/version.js";
import { findRoot, hasLocalInstall } from "../../lib/bridge";
import { useDesktopUpdateStatus } from "../../lib/updateCheck";
import "../../components/formFields.css";

export interface SettingsOutletContext {
  root: string | undefined;
  setRoot: (root: string | undefined) => void;
}

const TABS = [
  { to: "/app/settings", label: "Account", end: true },
  { to: "/app/settings/preferences", label: "Preferences" },
  { to: "/app/settings/accounts", label: "ATS accounts" },
];

/**
 * Settings used to be one long scrolling page: account status, hosted
 * inbox, resume, appearance, coding agent, Discord, run defaults, and the
 * scheduler all stacked in one column. "ATS accounts" was just a small
 * button inside the Account section, next to the signed-in email. Now
 * it's split into tabs (Account / Preferences / ATS accounts), each its
 * own focused screen. ATS accounts holds every stored credential aplyx
 * created on your behalf, so it gets equal footing instead of hiding
 * behind a button.
 *
 * root is resolved once here and handed to every tab via Outlet context
 * instead of each tab re-deriving it. Both Account (owns the "connect a
 * local install" flow) and Preferences (coding agent, run defaults,
 * Discord, scheduler, all local-install-scoped) need the same live
 * value.
 */
export function SettingsShell() {
  const [root, setRoot] = useState<string | undefined>(undefined);
  const desktopUpdate = useDesktopUpdateStatus();

  useEffect(() => {
    hasLocalInstall().then((has) => {
      setRoot(undefined);
      if (has) findRoot().then(setRoot);
    });
  }, []);

  return (
    <div style={{ maxWidth: "42rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <h1 style={{ fontSize: "var(--text-3xl)" }}>Settings</h1>

      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            role="tab"
            className={({ isActive }) => (isActive ? "settings-tab settings-tab-active" : "settings-tab")}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={{ root, setRoot } satisfies SettingsOutletContext} />

      {/* Same build marker the TUI shows (dimmed) in its side panel footer:
       * one shared @aplyx/core constant, so both surfaces always agree.
       * `aplyx update` (the TUI/core self-updater) can't reach this app's
       * own binary or its bundled bridge resource, both are baked in at
       * build time and only ever change on a fresh install, so this is
       * the desktop app's own, separate update check; see updateCheck.ts.
       * Shown on every tab (not tab-specific) since it's app info, not a
       * setting. */}
      {desktopUpdate.updateAvailable ? (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Desktop app update</h2>
          <div className="check-row">
            <span className="check-icon check-icon-fail">↑</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">Update available: {desktopUpdate.latest}</div>
              <div className="check-detail">
                You're on build {desktopUpdate.current}. Download and run the installer for your OS:
                it replaces this install in place; re-open aplyx afterward.
              </div>
            </div>
            <button
              type="button"
              className="settings-action-btn"
              onClick={() => void openUrl(desktopUpdate.releaseUrl)}
            >
              Get the update
            </button>
          </div>
        </section>
      ) : (
        <p style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
          build {BUILD_MARKER}
          {desktopUpdate.checking ? "" : " (latest)"}
        </p>
      )}
    </div>
  );
}
