import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { SupabaseAdapter, type HostedReadiness, type MailConnectionRow } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "../../lib/AuthContext";
import { setLocalRoot, forgetLocalRoot, readProfileFields } from "../../lib/bridge";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { useOauthBusyRecovery } from "../../lib/useOauthBusyRecovery";
import {
  readHostedProfileSnapshot,
  writeProfileSnapshotLocally,
  pullHostedResume,
  type HostedProfileSnapshot,
} from "../../lib/hostedPull";
import type { SettingsOutletContext } from "./SettingsShell";
import "../../components/formFields.css";
import "../../components/dataList.css";

const CODE_STYLE = {
  background: "var(--surface-raised)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.35rem",
  fontFamily: "var(--font-mono)",
  fontSize: "0.9em",
};

/** Account tab: who you're signed in as, the hosted inbox connection,
 *  resume-on-file, and which local install this window is pointed at.
 *  ATS accounts (the credentials aplyx creates on ATS sites) used to be a
 *  button right here next to the signed-in email; it's its own tab now,
 *  see SettingsShell.tsx. */
export function SettingsAccountTab() {
  const { status, session, signOut } = useAuth();
  const navigate = useNavigate();
  const { root, setRoot } = useOutletContext<SettingsOutletContext>();
  const [browsing, setBrowsing] = useState(false);
  const [rootError, setRootError] = useState<string | undefined>(undefined);
  const [hostedReadiness, setHostedReadiness] = useState<HostedReadiness | undefined>(undefined);
  const [mailConnection, setMailConnection] = useState<MailConnectionRow | undefined>(undefined);
  const [mailOauthBusy, setMailOauthBusy] = useState(false);
  const [mailOauthError, setMailOauthError] = useState<string | undefined>(undefined);
  const [disconnecting, setDisconnecting] = useState(false);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeUploadError, setResumeUploadError] = useState<string | undefined>(undefined);
  // Hosted-to-local profile pull (docs/web-onboarding-hosted-sync-plan.md
  // Part B): offered right here because this is the one place a local
  // install and a freshly-signed-in session are ever both true at once
  // (AuthScreen's default post-sign-in routing assumes no local install
  // exists; the "Sign in" button below opts out of that via `returnTo`
  // and lands back here instead). checked/dismissed/done all reset to
  // their defaults on their own the next time this component mounts,
  // deliberately not persisted, so a page revisit re-offers it rather
  // than remembering a "not now" forever.
  const [hostedPullChecked, setHostedPullChecked] = useState(false);
  const [hostedPullSnapshot, setHostedPullSnapshot] = useState<HostedProfileSnapshot | undefined>(undefined);
  const [localProfileHasData, setLocalProfileHasData] = useState(false);
  const [hostedPullDismissed, setHostedPullDismissed] = useState(false);
  const [hostedPullBusy, setHostedPullBusy] = useState(false);
  const [hostedPullError, setHostedPullError] = useState<string | undefined>(undefined);
  const [hostedPullDone, setHostedPullDone] = useState(false);

  useEffect(() => {
    if (status !== "signed-in" || !session || !root) {
      setHostedPullChecked(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const client = await getSupabaseClient();
        const [snapshot, localFields] = await Promise.all([
          readHostedProfileSnapshot(client, session.user.id),
          readProfileFields(root, ["first_name", "last_name"]),
        ]);
        if (cancelled) return;
        if (snapshot?.values.first_name) {
          setHostedPullSnapshot(snapshot);
          setLocalProfileHasData(Boolean(localFields.first_name || localFields.last_name));
        }
      } catch {
        // Fail open: no offer shown; the user can still fill in or edit
        // their profile normally, same as before this existed.
      } finally {
        if (!cancelled) setHostedPullChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, session, root]);

  async function acceptHostedPull() {
    if (!hostedPullSnapshot || !session || !root) return;
    setHostedPullBusy(true);
    setHostedPullError(undefined);
    try {
      await writeProfileSnapshotLocally(root, hostedPullSnapshot);
      if (hostedPullSnapshot.hasResume && hostedPullSnapshot.resumeFileName) {
        try {
          const client = await getSupabaseClient();
          await pullHostedResume(client, session.user.id, root, hostedPullSnapshot.resumeFileName);
        } catch {
          // Profile fields already landed, so a resume-pull failure
          // shouldn't block finishing; Settings' own resume upload above
          // still lets them add one manually.
        }
      }
      setHostedPullDone(true);
    } catch (err) {
      setHostedPullError(err instanceof Error ? err.message : String(err));
    } finally {
      setHostedPullBusy(false);
    }
  }

  // Same upload call the onboarding wizard's ResumeUploadStep.tsx uses
  // (upsert: true replaces the existing file in place): this is the
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
  // during onboarding; Settings needs its own listener so reconnecting or
  // switching to a different inbox email works without re-running the
  // whole hosted wizard. mail-oauth-callback's redirect carries the
  // connected email/provider, which supersedeMailConnections uses to
  // revoke any other still-"connected" row for that provider (reconnecting
  // under a new email inserts a second row rather than replacing the
  // first, see supabase.ts).
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

  // Recover the "Opening consent…" button when the deep-link callback
  // never comes (consent window closed, login failed, not an approved
  // tester). Without this the only reset is leaving Settings and coming
  // back.
  useOauthBusyRecovery({
    busy: mailOauthBusy,
    recheck: async () => {
      try {
        if (status !== "signed-in" || !session) return false;
        const client = await getSupabaseClient();
        const c = await new SupabaseAdapter(client, session.user.id).getInboxConnection();
        return c?.status === "connected";
      } catch {
        return false;
      }
    },
    onConnected: () => {
      setMailOauthBusy(false);
      void refreshInbox();
    },
    onGiveUp: () => {
      setMailOauthBusy(false);
      setMailOauthError((prev) => prev ?? "Consent wasn't completed. Click Connect to try again.");
    },
  });

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
    <>
      <section className="settings-section">
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Account</h2>
        {status === "signed-in" ? (
          <div className="check-row">
            <span className="check-icon check-icon-ok">✓</span>
            <div style={{ flex: 1 }}>
              <div className="check-label" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                {session?.user.email}
                {/* Every hosted account is on the single free tier today:
                 * docs/hosted-paid-tier-plan.md's paid tiers are "planned,
                 * not started," no plan/tier column exists yet. This is an
                 * honest label for the one real tier, not a live plan
                 * switcher; swap it for the real value once paid tiers
                 * actually ship. */}
                <span className="status-badge status-badge-muted">Free</span>
              </div>
              <div className="check-detail">Signed in. Your profile syncs across devices.</div>
            </div>
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
            <button
              type="button"
              className="settings-action-btn"
              onClick={() => navigate("/auth", { state: { returnTo: "/app/settings" } })}
            >
              Sign in
            </button>
          </div>
        )}
      </section>

      {status === "signed-in" && root && hostedPullChecked && hostedPullSnapshot && !hostedPullDismissed && !hostedPullDone && (
        <section className="settings-section aplyx-fade-rise">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Use your saved account data?</h2>
          <p className="field-help">
            This account already has a profile saved, from the web dashboard or another device.
            {localProfileHasData
              ? " This will replace the profile already saved on this local install"
              : " Bring it into this local install instead of re-entering everything"}
            {hostedPullSnapshot.hasResume ? ", including a saved resume." : "."}
          </p>
          {hostedPullError && (
            <p className="field-help" style={{ color: "var(--danger)" }}>
              {hostedPullError}
            </p>
          )}
          <div className="detail-actions">
            <button
              type="button"
              className="settings-action-btn"
              onClick={() => setHostedPullDismissed(true)}
              disabled={hostedPullBusy}
            >
              Not now
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void acceptHostedPull()} disabled={hostedPullBusy}>
              {hostedPullBusy ? "Importing…" : "Import my saved profile"}
            </button>
          </div>
        </section>
      )}

      {hostedPullDone && (
        <section className="settings-section aplyx-fade-rise">
          <p className="field-help">
            Import complete. Everything above now lives in this local install too.{" "}
            <button
              type="button"
              onClick={() => navigate("/app/profile")}
              style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", font: "inherit", textDecoration: "underline", cursor: "pointer" }}
            >
              Review it
            </button>
            .
          </p>
        </section>
      )}

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
                  ? "Uploading a new PDF replaces this one; aplyx always tailors from whatever is currently on file."
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
                Job search and applying run through a local install: point the app at your aplyx
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
    </>
  );
}
