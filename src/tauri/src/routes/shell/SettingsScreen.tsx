import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { BUILD_MARKER } from "@aplyx/core/version.js";
import { SupabaseAdapter, type HostedReadiness, type MailConnectionRow } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "../../lib/AuthContext";
import { findRoot, hasLocalInstall, setLocalRoot, forgetLocalRoot, getSchedulerStatus, setSchedulerInstalled, type SchedulerStatus } from "../../lib/bridge";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { useDesktopUpdateStatus } from "../../lib/updateCheck";
import { useUiPrefs, FONT_LABELS, type FontPref, type ThemePref } from "../../lib/uiPrefs";
import { Dropdown } from "../../components/Dropdown";
import { Switch } from "../../components/Switch";
import "../../components/formFields.css";

const CODE_STYLE = {
  background: "var(--surface-raised)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.35rem",
  fontFamily: "var(--font-mono)",
  fontSize: "0.9em",
};

const THEME_OPTIONS: { value: ThemePref; label: string; detail: string }[] = [
  { value: "system", label: "System", detail: "Follow the OS appearance" },
  { value: "light", label: "Light", detail: "Always light" },
  { value: "dark", label: "Dark", detail: "Always dark" },
];

const FONT_OPTIONS: { value: FontPref; detail: string }[] = [
  { value: "manrope", detail: "Bundled Manrope + Inter — the default; Supabase's own display + body pairing" },
  { value: "system", detail: "Your OS's native UI font" },
  { value: "geist", detail: "Bundled Geist + Geist Mono — modern, technical-product feel" },
  { value: "inter", detail: "Bundled Inter — strong for dense, tabular product UI" },
  { value: "plex", detail: "Bundled IBM Plex Sans + Plex Mono — enterprise, analytical tone" },
  { value: "atkinson", detail: "Bundled Atkinson Hyperlegible Next — accessibility- and readability-first" },
];

export function SettingsScreen() {
  const { status, session, signOut } = useAuth();
  const navigate = useNavigate();
  const { theme, font, setTheme, setFont } = useUiPrefs();
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const [rootError, setRootError] = useState<string | undefined>(undefined);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | undefined>(undefined);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  // Which direction the in-flight toggle is headed — lets the busy-state
  // copy say something specific ("Stopping current run…") instead of a
  // generic "Working…". Turning off is the one that can genuinely take a
  // few seconds (it has to wait for a live scheduled run to actually
  // finish exiting, not just fire a signal and hope); turning on is
  // normally near-instant.
  const [schedulerTarget, setSchedulerTarget] = useState<boolean | undefined>(undefined);
  const [schedulerError, setSchedulerError] = useState<string | undefined>(undefined);
  const [hostedReadiness, setHostedReadiness] = useState<HostedReadiness | undefined>(undefined);
  const [mailConnection, setMailConnection] = useState<MailConnectionRow | undefined>(undefined);
  const [mailOauthBusy, setMailOauthBusy] = useState(false);
  const [mailOauthError, setMailOauthError] = useState<string | undefined>(undefined);
  const [disconnecting, setDisconnecting] = useState(false);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeUploadError, setResumeUploadError] = useState<string | undefined>(undefined);
  const desktopUpdate = useDesktopUpdateStatus();

  // Same upload call the onboarding wizard's ResumeUploadStep.tsx uses
  // (upsert: true replaces the existing file in place) — this is the
  // permanent action that step's own copy already promised existed
  // ("add a resume later from Settings") but that, until now, nothing
  // actually built.
  async function handleResumeFile(file: File) {
    if (status !== "signed-in" || !session) return;
    setResumeUploadError(undefined);
    setResumeUploading(true);
    try {
      const client = await getSupabaseClient();
      const { error: uploadError } = await client.storage
        .from("resumes")
        .upload(`${session.user.id}/${file.name}`, file, { upsert: true });
      if (uploadError) {
        setResumeUploadError(uploadError.message);
        return;
      }
      await refreshInbox();
    } finally {
      setResumeUploading(false);
    }
  }

  async function refreshInbox() {
    if (status !== "signed-in" || !session) return;
    const client = await getSupabaseClient();
    const adapter = new SupabaseAdapter(client, session.user.id);
    const [readiness, connection] = await Promise.all([
      adapter.readHostedReadiness(),
      adapter.getInboxConnection(),
    ]);
    setHostedReadiness(readiness);
    setMailConnection(connection);
  }

  const refreshLocalInstall = () => {
    hasLocalInstall().then((has) => {
      setRoot(undefined);
      if (has) findRoot().then(setRoot);
    });
  };

  useEffect(refreshLocalInstall, []);

  useEffect(() => {
    if (!root) return;
    getSchedulerStatus(root)
      .then(setSchedulerStatus)
      .catch(() => setSchedulerStatus(undefined));
  }, [root]);

  useEffect(() => {
    if (status !== "signed-in" || !session) return;
    let cancelled = false;
    refreshInbox().catch(() => {
      if (cancelled) return;
      setHostedReadiness(undefined);
      setMailConnection(undefined);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, session]);

  // Same aplyx://mail-callback deep link EmailTrackingStep listens for
  // during onboarding — Settings needs its own listener so reconnecting or
  // switching to a different inbox email works without re-running the
  // whole hosted wizard. mail-oauth-callback's redirect carries the
  // connected email/provider, which supersedeMailConnections uses to
  // revoke any other still-"connected" row for that provider (reconnecting
  // under a new email inserts a second row rather than replacing the
  // first — see supabase.ts).
  useEffect(() => {
    if (status !== "signed-in" || !session) return;
    const unlisten = onOpenUrl(async (urls) => {
      const incoming = urls.find((u) => u.startsWith("aplyx://mail-callback"));
      if (!incoming) return;
      const url = new URL(incoming);
      const oauthProvider = url.searchParams.get("provider");
      const oauthStatus = url.searchParams.get("status") ?? "error";
      const message = url.searchParams.get("message") ?? "";
      const email = url.searchParams.get("email");
      setMailOauthBusy(false);
      if (oauthStatus !== "connected") {
        setMailOauthError(message || "Inbox connection failed.");
        return;
      }
      setMailOauthError(undefined);
      try {
        if (oauthProvider && email) {
          const client = await getSupabaseClient();
          await new SupabaseAdapter(client, session.user.id).supersedeMailConnections(oauthProvider, email);
        }
        await refreshInbox();
      } catch (err) {
        setMailOauthError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, session]);

  async function startMailOauth(provider: "gmail" | "microsoft") {
    setMailOauthBusy(true);
    setMailOauthError(undefined);
    try {
      const client = await getSupabaseClient();
      const { data, error } = await client.functions.invoke<{ auth_url?: string; error?: string }>("mail-oauth-start", {
        body: { provider },
      });
      if (error || !data?.auth_url) {
        setMailOauthBusy(false);
        setMailOauthError(error?.message ?? data?.error ?? `${provider} inbox OAuth isn't available yet.`);
        return;
      }
      await openUrl(data.auth_url);
      // Left busy: the button reads "Opening consent…" until the deep-link
      // listener above resolves it one way or the other, same pattern as
      // EmailTrackingStep's startOauth.
    } catch (err) {
      setMailOauthBusy(false);
      setMailOauthError(err instanceof Error ? err.message : String(err));
    }
  }

  async function disconnectInbox() {
    if (!session || !mailConnection || mailConnection.id === "email_tracking_config") return;
    setDisconnecting(true);
    setMailOauthError(undefined);
    try {
      const client = await getSupabaseClient();
      await new SupabaseAdapter(client, session.user.id).disconnectMailConnection(mailConnection.id);
      await refreshInbox();
    } catch (err) {
      setMailOauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  }

  async function toggleScheduler() {
    if (!root || !schedulerStatus) return;
    const target = !schedulerStatus.installed;
    const previous = schedulerStatus;
    // Optimistic flip: the switch moves the instant you click, before the
    // backend round-trip even starts — uninstall in particular can take a
    // real several seconds when it has to verify a currently-running
    // scheduled job has actually finished tearing down (not just fire a
    // signal and hope — see scheduler.py's _bootout_and_verify), and with
    // no visual change during that wait a click looked like it did
    // nothing, which is exactly what invited repeated clicking. Rolled
    // back below only if the call actually fails.
    setSchedulerStatus({ ...schedulerStatus, installed: target });
    setSchedulerTarget(target);
    setSchedulerBusy(true);
    setSchedulerError(undefined);
    try {
      const next = await setSchedulerInstalled(root, target);
      setSchedulerStatus(next);
    } catch (err) {
      setSchedulerStatus(previous);
      setSchedulerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulerBusy(false);
      setSchedulerTarget(undefined);
    }
  }

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
    <div style={{ maxWidth: "42rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <h1 style={{ fontSize: "var(--text-3xl)" }}>Settings</h1>

      <section className="settings-section">
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Account</h2>
        {status === "signed-in" ? (
          <div className="check-row">
            <span className="check-icon check-icon-ok">✓</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">{session?.user.email}</div>
              <div className="check-detail">Signed in — your profile syncs across devices.</div>
            </div>
            <button type="button" className="settings-action-btn" onClick={() => navigate("/app/accounts")}>
              ATS accounts
            </button>
            <button type="button" className="settings-action-btn" onClick={() => signOut().then(() => navigate("/"))}>
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
            <button type="button" className="settings-action-btn" onClick={() => navigate("/auth")}>
              Sign in
            </button>
          </div>
        )}
      </section>

      {status === "signed-in" && hostedReadiness && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Hosted inbox</h2>
          <div className="check-row">
            <span className={`check-icon ${hostedReadiness.inboxConnected ? "check-icon-ok" : "check-icon-pending"}`}>
              {hostedReadiness.inboxConnected ? "✓" : "–"}
            </span>
            <div style={{ flex: 1 }}>
              <div className="check-label">{mailConnection?.email_address ?? hostedReadiness.candidateEmail ?? "Inbox not connected"}</div>
              <div className="check-detail">
                {hostedReadiness.inboxConnected
                  ? `Connected via ${mailConnection?.provider ?? hostedReadiness.inboxProvider}. Hosted verification sessions can watch this inbox.`
                  : "Hosted plans require an inbox connection for gated ATS verification."}
              </div>
            </div>
            {hostedReadiness.inboxConnected ? (
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                {(mailConnection?.provider === "gmail" || mailConnection?.provider === "microsoft") && (
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={() => void startMailOauth(mailConnection.provider as "gmail" | "microsoft")}
                    disabled={mailOauthBusy || disconnecting}
                  >
                    {mailOauthBusy ? "Opening consent…" : "Use a different email"}
                  </button>
                )}
                {mailConnection && mailConnection.id !== "email_tracking_config" && (
                  <button
                    type="button"
                    className="settings-action-btn settings-action-btn-danger"
                    onClick={() => void disconnectInbox()}
                    disabled={disconnecting || mailOauthBusy}
                  >
                    {disconnecting ? "Disconnecting…" : "Disconnect"}
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => void startMailOauth("gmail")}
                disabled={mailOauthBusy}
              >
                {mailOauthBusy ? "Opening consent…" : "Connect Gmail inbox"}
              </button>
            )}
          </div>
          {mailOauthError && (
            <p className="field-help" style={{ color: "var(--danger)" }}>
              {mailOauthError}
            </p>
          )}
          <p className="field-help">
            Candidate email: <code style={CODE_STYLE}>{hostedReadiness.candidateEmail || "not set"}</code>
          </p>
        </section>
      )}

      {status === "signed-in" && hostedReadiness && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Resume</h2>
          <input
            ref={resumeInputRef}
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) void handleResumeFile(file);
            }}
          />
          <div className="check-row">
            <span className={`check-icon ${hostedReadiness.resumeUploaded ? "check-icon-ok" : "check-icon-pending"}`}>
              {hostedReadiness.resumeUploaded ? "✓" : "–"}
            </span>
            <div style={{ flex: 1 }}>
              <div className="check-label">{hostedReadiness.resumeUploaded ? "Resume on file" : "No resume uploaded"}</div>
              <div className="check-detail">
                {hostedReadiness.resumeUploaded
                  ? "Uploading a new PDF replaces this one — aplyx always tailors from whatever is currently on file."
                  : "Upload a PDF so a signed-in session anywhere has something to tailor from."}
              </div>
            </div>
            <button type="button" className="settings-action-btn" onClick={() => resumeInputRef.current?.click()} disabled={resumeUploading}>
              {resumeUploading ? "Uploading…" : hostedReadiness.resumeUploaded ? "Replace resume" : "Upload resume"}
            </button>
          </div>
          {resumeUploadError && (
            <p className="field-help" style={{ color: "var(--danger)" }}>
              {resumeUploadError}
            </p>
          )}
        </section>
      )}

      <section className="settings-section">
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Appearance</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
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
            <p className="field-help">System follows your OS and switches automatically; Light/Dark pin it.</p>
          </div>
          <div className="field">
            <span className="field-label">Font</span>
            <Dropdown
              value={font}
              onChange={setFont}
              label="Font"
              options={FONT_OPTIONS.map((opt) => ({ value: opt.value, label: FONT_LABELS[opt.value] }))}
            />
            <p className="field-help">
              {FONT_OPTIONS.find((o) => o.value === font)?.detail} Bundled fonts apply to the
              whole interface, including headlines and code — no download, works offline.
            </p>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Local install</h2>
        {root ? (
          <div className="check-row">
            <span className="check-icon check-icon-ok">✓</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">Connected</div>
              <div className="check-detail">{root}</div>
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <button type="button" className="settings-action-btn" onClick={changeFolder} disabled={browsing}>
                {browsing ? "Choosing…" : "Change folder…"}
              </button>
              <button type="button" className="settings-action-btn" onClick={() => navigate("/onboarding/local")}>
                Reopen setup
              </button>
            </div>
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
            <button type="button" className="settings-action-btn" onClick={() => void browseForRoot()} disabled={browsing}>
              {browsing ? "Choosing…" : "Browse…"}
            </button>
          </div>
        )}
        {rootError ? <p className="field-help" style={{ color: "var(--danger)" }}>{rootError}</p> : null}
      </section>

      {root && schedulerStatus && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Scheduler</h2>
          <div className="check-row">
            <div style={{ flex: 1 }}>
              <div className="check-label">
                {schedulerBusy
                  ? schedulerTarget
                    ? "Starting…"
                    : "Stopping current run…"
                  : schedulerStatus.installed
                    ? `Running every ${schedulerStatus.interval_min} min`
                    : "Not running"}
              </div>
              <div className="check-detail">
                {schedulerBusy
                  ? schedulerTarget
                    ? "Registering the background schedule."
                    : "Waiting for a live scrape/apply session to finish exiting — can take a few seconds."
                  : schedulerStatus.installed
                    ? "Scrapes and applies automatically in the background, 24/7."
                    : "Turn on to scrape and apply automatically every 30 minutes, in the background."}
              </div>
            </div>
            <Switch
              checked={schedulerStatus.installed}
              onChange={() => void toggleScheduler()}
              disabled={schedulerBusy}
              label="Scheduler"
            />
          </div>
          {schedulerError ? <p className="field-help" style={{ color: "var(--danger)" }}>{schedulerError}</p> : null}
          <p className="field-help">
            This toggle and the terminal control the same thing — you can also turn it on/off with{" "}
            <code style={CODE_STYLE}>python3 src/scripts/runtime/scheduler.py install</code> /{" "}
            <code style={CODE_STYLE}>uninstall</code> from your aplyx checkout, or check its status with{" "}
            <code style={CODE_STYLE}>scheduler.py status</code>.
          </p>
        </section>
      )}

      {/* Same build marker the TUI shows (dimmed) in its side panel footer
       * — one shared @aplyx/core constant, so both surfaces always agree.
       * `aplyx update` (the TUI/core self-updater) can't reach this app's
       * own binary or its bundled bridge resource — both are baked in at
       * build time and only ever change on a fresh install — so this is
       * the desktop app's own, separate update check; see updateCheck.ts. */}
      {desktopUpdate.updateAvailable ? (
        <section className="settings-section">
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
