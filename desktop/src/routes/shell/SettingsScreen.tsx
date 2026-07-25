import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BUILD_MARKER } from "@aplyx/core/version.js";
import { useAuth } from "../../lib/AuthContext";
import { findRoot, hasLocalInstall, setLocalRoot, forgetLocalRoot } from "../../lib/bridge";
import { useDesktopUpdateStatus } from "../../lib/updateCheck";
import {
  useUiPrefs,
  THEME_FAMILY_LABELS,
  FONT_LABELS,
  type FontPref,
  type ThemeFamily,
  type ThemePref,
} from "../../lib/uiPrefs";
import "../../components/formFields.css";

const THEME_OPTIONS: { value: ThemePref; label: string; detail: string }[] = [
  { value: "system", label: "System", detail: "Follow the OS appearance" },
  { value: "light", label: "Light", detail: "This family's light mode, always" },
  { value: "dark", label: "Dark", detail: "This family's dark mode, always" },
];

const THEME_FAMILY_OPTIONS: { value: ThemeFamily; detail: string }[] = [
  { value: "cobalt", detail: "Cool blue-tinted neutrals, cobalt accent — the default" },
  { value: "sage", detail: "Quieter, softer, less saturated green-gray accent" },
  { value: "legacy", detail: "The original warm beige + violet/plum look" },
  { value: "graphite", detail: "Darker, more technical, ops-console feeling" },
  { value: "ember", detail: "Warm and inviting — burnt orange-red on cream, glowing amber in dark mode" },
];

const FONT_OPTIONS: { value: FontPref; detail: string }[] = [
  { value: "system", detail: "Your OS's native UI font" },
  { value: "geist", detail: "Bundled Geist + Geist Mono — modern, technical-product feel" },
  { value: "inter", detail: "Bundled Inter — strong for dense, tabular product UI" },
  { value: "plex", detail: "Bundled IBM Plex Sans + Plex Mono — enterprise, analytical tone" },
  { value: "atkinson", detail: "Bundled Atkinson Hyperlegible Next — accessibility- and readability-first" },
];

export function SettingsScreen() {
  const { status, session, signOut } = useAuth();
  const navigate = useNavigate();
  const { theme, themeFamily, font, setTheme, setThemeFamily, setFont } = useUiPrefs();
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const [rootError, setRootError] = useState<string | undefined>(undefined);
  const desktopUpdate = useDesktopUpdateStatus();

  const refreshLocalInstall = () => {
    hasLocalInstall().then((has) => {
      setRoot(undefined);
      if (has) findRoot().then(setRoot);
    });
  };

  useEffect(refreshLocalInstall, []);

  async function browseForRoot() {
    setBrowsing(true);
    setRootError(undefined);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select your aplyx checkout folder",
      });
      if (typeof selected !== "string") return; // cancelled
      const resolved = await setLocalRoot(selected);
      setRoot(resolved);
    } catch (err) {
      setRootError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowsing(false);
    }
  }

  function changeFolder() {
    forgetLocalRoot();
    void browseForRoot();
  }

  return (
    <div style={{ maxWidth: "34rem", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <h1 style={{ fontSize: "var(--text-3xl)" }}>Settings</h1>

      <section>
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Account</h2>
        {status === "signed-in" ? (
          <div className="check-row">
            <span className="check-icon check-icon-ok">✓</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">{session?.user.email}</div>
              <div className="check-detail">Signed in — your profile syncs across devices.</div>
            </div>
            <button type="button" className="wizard-back" onClick={() => signOut().then(() => navigate("/"))}>
              Sign out
            </button>
          </div>
        ) : (
          <div className="check-row">
            <span className="check-icon check-icon-pending">–</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">Not signed in</div>
              <div className="check-detail">Running locally. Sign in to sync across devices.</div>
            </div>
            <button type="button" className="wizard-back" onClick={() => navigate("/auth")}>
              Sign in
            </button>
          </div>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Appearance</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div className="field">
            <span className="field-label">Theme family</span>
            <div className="yesno-toggle" role="group" aria-label="Theme family">
              {THEME_FAMILY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={themeFamily === opt.value ? "selected" : ""}
                  title={opt.detail}
                  onClick={() => setThemeFamily(opt.value)}
                >
                  {THEME_FAMILY_LABELS[opt.value]}
                </button>
              ))}
            </div>
            <p className="field-help">
              {THEME_FAMILY_OPTIONS.find((o) => o.value === themeFamily)?.detail}
            </p>
          </div>
          <div className="field">
            <span className="field-label">Mode</span>
            <div className="yesno-toggle" role="group" aria-label="Mode">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={theme === opt.value ? "selected" : ""}
                  title={opt.detail}
                  onClick={() => setTheme(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="field-help">
              System follows your OS and switches automatically; Light/Dark pin the current
              theme family to that mode.
            </p>
          </div>
          <div className="field">
            <span className="field-label">Font</span>
            <div className="yesno-toggle" role="group" aria-label="Font">
              {FONT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={font === opt.value ? "selected" : ""}
                  title={opt.detail}
                  onClick={() => setFont(opt.value)}
                >
                  {FONT_LABELS[opt.value]}
                </button>
              ))}
            </div>
            <p className="field-help">
              {FONT_OPTIONS.find((o) => o.value === font)?.detail} Bundled fonts apply to the
              whole interface, including headlines and code — no download, works offline.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Local install</h2>
        {root ? (
          <div className="check-row">
            <span className="check-icon check-icon-ok">✓</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">Connected</div>
              <div className="check-detail">{root}</div>
            </div>
            <button type="button" className="wizard-back" onClick={changeFolder} disabled={browsing}>
              {browsing ? "Choosing…" : "Change folder…"}
            </button>
            <button type="button" className="wizard-back" onClick={() => navigate("/onboarding/local")}>
              Reopen setup
            </button>
          </div>
        ) : (
          <div className="check-row">
            <span className="check-icon check-icon-pending">–</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">No local installation found</div>
              <div className="check-detail">
                Job search and applying run through a local install — point the app at your aplyx
                checkout folder.
              </div>
            </div>
            <button type="button" className="wizard-back" onClick={() => void browseForRoot()} disabled={browsing}>
              {browsing ? "Choosing…" : "Browse…"}
            </button>
          </div>
        )}
        {rootError ? <p className="field-help" style={{ color: "var(--danger)" }}>{rootError}</p> : null}
      </section>

      {/* Same build marker the TUI shows (dimmed) in its side panel footer
       * — one shared @aplyx/core constant, so both surfaces always agree.
       * `aplyx update` (the TUI/core self-updater) can't reach this app's
       * own binary or its bundled bridge resource — both are baked in at
       * build time and only ever change on a fresh install — so this is
       * the desktop app's own, separate update check; see updateCheck.ts. */}
      {desktopUpdate.updateAvailable ? (
        <section>
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Desktop app update</h2>
          <div className="check-row">
            <span className="check-icon check-icon-fail">↑</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">Update available: {desktopUpdate.latest}</div>
              <div className="check-detail">
                You're on build {desktopUpdate.current}. Download and run the installer for your OS —
                it replaces this install in place; re-open aplyx afterward.
              </div>
            </div>
            <button
              type="button"
              className="wizard-back"
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
