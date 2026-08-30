import { useEffect, useState } from "react";
import { SupabaseAdapter, type ApplicationAccountRow } from "@aplyx/core/adapters/supabase.js";
import { tenantKeyFor } from "@aplyx/core/atsRegistry.js";
import { useAuth } from "../../lib/AuthContext";
import { readWorkdayCredential, saveWorkdayCredential } from "../../lib/bridge";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { Modal } from "../../components/Modal";
import { Switch } from "../../components/Switch";
import { useOutletContext } from "react-router-dom";
import type { SettingsOutletContext } from "./SettingsShell";
import "../../components/formFields.css";
import "../../components/dataList.css";

/** ATS account credentials (docs/ats-account-credentials-plan.md
 *  Package 6). Supabase Vault is the canonical cross-device store. A local
 *  OS-keychain copy is only an explicit device cache for the local Workday
 *  runtime; it is never the source of truth.
 *
 *  "Recent re-authentication" (the operator's "short session window"
 *  decision) is tracked purely as in-memory component state
 *  (lastReauthAt) — never persisted, gone the moment this screen
 *  unmounts or the app restarts, same spirit as the plan's own "short-
 *  lived" language for verification state. Reveal/copy/rotate all gate
 *  on it; disabling tracking and deleting don't, since neither exposes
 *  or changes a credential. */

const REAUTH_WINDOW_MS = 10 * 60 * 1000;

const STATUS_BADGE: Record<string, string> = {
  active: "status-badge-good",
  creation_pending: "status-badge-info",
  created_unverified: "status-badge-info",
  verification_pending: "status-badge-info",
  login_failed: "status-badge-danger",
  locked: "status-badge-danger",
  reset_required: "status-badge-warn",
  disabled: "status-badge-muted",
};

function statusBadgeClass(status: string): string {
  return `status-badge ${STATUS_BADGE[status] ?? "status-badge-muted"}`;
}

function familyLabel(family: string): string {
  if (family === "ashbyhq") return "Ashby";
  return family.charAt(0).toUpperCase() + family.slice(1);
}

type PendingAction = { accountId: string; kind: "reveal" | "rotate" | "sync" };

export function AccountCenterScreen() {
  const { status, session, signInWithGoogle } = useAuth();
  const { root } = useOutletContext<SettingsOutletContext>();
  const [accounts, setAccounts] = useState<ApplicationAccountRow[] | undefined>(undefined);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [workdayHost, setWorkdayHost] = useState("");
  const [workdayCompany, setWorkdayCompany] = useState("");
  const [workdayUsername, setWorkdayUsername] = useState("");
  const [workdayPassword, setWorkdayPassword] = useState("");
  const [workdaySaving, setWorkdaySaving] = useState(false);
  const [workdayError, setWorkdayError] = useState<string | undefined>(undefined);

  // A Google-only account (no "email" identity ever added) has no password
  // to re-enter — Supabase's identities array is the source of truth for
  // which providers a user actually authenticated with, not app_metadata
  // (which only names the *first* provider used at signup). Re-authing one
  // of these accounts has to go back through Google instead of a password
  // prompt, or reveal/rotate is permanently unreachable for them (2026-08-27,
  // reported: a Google sign-in user stuck on "Confirm your password" with no
  // password to enter).
  const hasPasswordIdentity = session?.user.identities?.some((i) => i.provider === "email") ?? true;

  const [lastReauthAt, setLastReauthAt] = useState<number | undefined>(undefined);
  const [pendingAction, setPendingAction] = useState<PendingAction | undefined>(undefined);
  const [reauthPassword, setReauthPassword] = useState("");
  const [reauthError, setReauthError] = useState<string | undefined>(undefined);
  const [reauthBusy, setReauthBusy] = useState(false);
  // Set right after signInWithGoogle() opens the system browser; the actual
  // sign-in completes out-of-band (AuthContext's onOpenUrl deep-link
  // handler exchanges the PKCE code and pushes a fresh `session` through
  // onAuthStateChange) — the effect below watches for that and finishes
  // the pending reveal/rotate once it lands, the Google-flow counterpart to
  // confirmReauth's synchronous signInWithPassword success path.
  const [googleReauthPending, setGoogleReauthPending] = useState(false);

  const [revealedFor, setRevealedFor] = useState<string | undefined>(undefined);
  const [revealedCredential, setRevealedCredential] = useState<{ username: string; password: string } | undefined>(undefined);

  const [rotateAccountId, setRotateAccountId] = useState<string | undefined>(undefined);
  const [rotateUsername, setRotateUsername] = useState("");
  const [rotatePassword, setRotatePassword] = useState("");
  const [rotateError, setRotateError] = useState<string | undefined>(undefined);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined);

  async function refresh() {
    if (status !== "signed-in" || !session) return;
    const client = await getSupabaseClient();
    const adapter = new SupabaseAdapter(client, session.user.id);
    const rows = await adapter.listApplicationAccounts();
    setAccounts(rows);
  }

  function normalizedWorkdayTenant(rawHost: string): string {
    const candidate = rawHost.trim().includes("://") ? rawHost.trim() : `https://${rawHost.trim()}`;
    const url = new URL(candidate);
    const tenant = tenantKeyFor("workday", url.toString());
    if (!tenant) throw new Error("Workday tenant must be a hostname ending in .myworkdayjobs.com");
    return tenant;
  }

  async function persistWorkdayCredential(host: string, company: string, username: string, password: string): Promise<string | undefined> {
    const tenantKey = normalizedWorkdayTenant(host);
    const trimmedCompany = company.trim();
    const trimmedUsername = username.trim();
    if (!trimmedCompany) throw new Error("Company name is required.");
    if (!trimmedUsername || !trimmedUsername.includes("@")) throw new Error("Workday account email is invalid.");
    if (!password || password.includes("\n") || password.includes("\r")) throw new Error("Workday password must be non-empty and single-line.");
    const client = await getSupabaseClient();
    const adapter = new SupabaseAdapter(client, session!.user.id);
    const { accountId } = await adapter.createOrReuseApplicationAccount({
      family: "workday",
      tenantKey,
      companyName: trimmedCompany,
      username: trimmedUsername,
      password,
    });
    // create_application_account is idempotent and intentionally does not
    // overwrite an existing secret; rotate makes an explicit user save update
    // the matching Vault secret instead of silently retaining an old password.
    await adapter.rotateApplicationAccountSecret(accountId, trimmedUsername, password);
    if (!root) return undefined;
    try {
      await saveWorkdayCredential(tenantKey, trimmedUsername, password);
      return " It is also cached in this device's secure credential store for local Workday runs.";
    } catch (err) {
      return ` The online credential is saved, but this device cache could not be updated: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function saveWorkdayAccount() {
    setWorkdaySaving(true);
    setWorkdayError(undefined);
    try {
      const deviceNote = await persistWorkdayCredential(workdayHost, workdayCompany, workdayUsername, workdayPassword);
      setWorkdayPassword("");
      setMessage({ text: `Workday credential saved to your online ATS account vault.${deviceNote ?? ""}` });
      await refresh();
    } catch (err) {
      setWorkdayError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkdaySaving(false);
    }
  }

  async function importDeviceWorkdayAccount() {
    setWorkdaySaving(true);
    setWorkdayError(undefined);
    try {
      const local = await readWorkdayCredential(workdayHost, workdayUsername);
      const deviceNote = await persistWorkdayCredential(local.host, workdayCompany, local.email, local.password);
      setWorkdayUsername(local.email);
      setMessage({ text: `The device credential was imported into your online ATS account vault.${deviceNote ?? ""}` });
      await refresh();
    } catch (err) {
      setWorkdayError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkdaySaving(false);
    }
  }

  useEffect(() => {
    if (status !== "signed-in" || !session) return;
    refresh().catch((err) => setMessage({ text: err instanceof Error ? err.message : String(err), error: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, session]);

  function hasRecentAuth(): boolean {
    return lastReauthAt !== undefined && Date.now() - lastReauthAt < REAUTH_WINDOW_MS;
  }

  /** Reveal and rotate both funnel through here: if re-auth is fresh
   *  enough, run the action immediately; otherwise stash which action
   *  was requested and open the password-confirm prompt, which re-runs
   *  this same function once signInWithPassword succeeds. */
  function requireRecentAuth(accountId: string, kind: PendingAction["kind"], run: () => void) {
    if (hasRecentAuth()) {
      run();
      return;
    }
    setPendingAction({ accountId, kind });
    setReauthPassword("");
    setReauthError(undefined);
  }

  /** Shared success tail for both re-auth paths: mark the window fresh,
   *  close the prompt, and run whichever action (reveal/rotate) was
   *  actually pending. */
  function completeReauth(action: PendingAction) {
    setLastReauthAt(Date.now());
    setPendingAction(undefined);
    setReauthPassword("");
    setGoogleReauthPending(false);
    if (action.kind === "reveal") void doReveal(action.accountId);
    if (action.kind === "rotate") setRotateAccountId(action.accountId);
    if (action.kind === "sync") {
      const account = accounts?.find((candidate) => candidate.id === action.accountId);
      if (account) void syncToDevice(account);
    }
  }

  async function confirmReauth() {
    if (!session?.user.email || !pendingAction) return;
    setReauthBusy(true);
    setReauthError(undefined);
    try {
      const client = await getSupabaseClient();
      const { error } = await client.auth.signInWithPassword({ email: session.user.email, password: reauthPassword });
      if (error) {
        setReauthError(error.message);
        return;
      }
      completeReauth(pendingAction);
    } finally {
      setReauthBusy(false);
    }
  }

  /** Google-only accounts have no password to re-enter — this reopens the
   *  system-browser Google sign-in instead (same signInWithGoogle() the
   *  entry screen uses) and leaves googleReauthPending set; the effect
   *  below finishes the pending action once AuthContext's deep-link
   *  handler completes the round trip and pushes a fresh `session`. */
  async function confirmReauthWithGoogle() {
    if (!pendingAction) return;
    setReauthBusy(true);
    setReauthError(undefined);
    try {
      const { error } = await signInWithGoogle();
      if (error) {
        setReauthError(error);
        return;
      }
      setGoogleReauthPending(true);
    } finally {
      setReauthBusy(false);
    }
  }

  // Fires once AuthContext's onOpenUrl handler exchanges the Google
  // callback's PKCE code and onAuthStateChange pushes the resulting
  // session through — the async counterpart to confirmReauth's synchronous
  // signInWithPassword success branch above.
  useEffect(() => {
    if (!googleReauthPending || !pendingAction || !session) return;
    completeReauth(pendingAction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, googleReauthPending]);

  async function doReveal(accountId: string) {
    setBusyId(accountId);
    try {
      const client = await getSupabaseClient();
      const adapter = new SupabaseAdapter(client, session!.user.id);
      const credential = await adapter.revealApplicationAccountCredential(accountId);
      setRevealedFor(accountId);
      setRevealedCredential(credential);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusyId(undefined);
    }
  }

  async function syncToDevice(account: ApplicationAccountRow) {
    if (account.ats_family !== "workday") return;
    setBusyId(account.id);
    try {
      const client = await getSupabaseClient();
      const adapter = new SupabaseAdapter(client, session!.user.id);
      const credential = await adapter.revealApplicationAccountCredential(account.id);
      await saveWorkdayCredential(account.tenant_key, credential.username, credential.password);
      setMessage({ text: `${account.company_name} is now available to this device's local Workday runtime.` });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusyId(undefined);
    }
  }

  function hideRevealed() {
    setRevealedFor(undefined);
    setRevealedCredential(undefined);
  }

  async function copyRevealed(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage({ text: `Copied ${label} to clipboard` });
    } catch (err) {
      setMessage({ text: `Could not copy: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  }

  function openRotate(accountId: string) {
    setRotateUsername("");
    setRotatePassword("");
    setRotateError(undefined);
    requireRecentAuth(accountId, "rotate", () => setRotateAccountId(accountId));
  }

  async function submitRotate() {
    if (!rotateAccountId) return;
    if (!rotateUsername.trim() || !rotatePassword) {
      setRotateError("Username and password are both required.");
      return;
    }
    setBusyId(rotateAccountId);
    setRotateError(undefined);
    try {
      const client = await getSupabaseClient();
      const adapter = new SupabaseAdapter(client, session!.user.id);
      await adapter.rotateApplicationAccountSecret(rotateAccountId, rotateUsername.trim(), rotatePassword);
      setRotateAccountId(undefined);
      hideRevealed();
      setMessage({ text: "Credential rotated." });
      await refresh();
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(undefined);
    }
  }

  async function toggleTracking(accountId: string, enabled: boolean) {
    setBusyId(accountId);
    try {
      const client = await getSupabaseClient();
      const adapter = new SupabaseAdapter(client, session!.user.id);
      await adapter.setApplicationAccountStatusTracking(accountId, enabled);
      await refresh();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusyId(undefined);
    }
  }

  async function confirmDelete() {
    if (!confirmDeleteId) return;
    const accountId = confirmDeleteId;
    setBusyId(accountId);
    try {
      const client = await getSupabaseClient();
      const adapter = new SupabaseAdapter(client, session!.user.id);
      await adapter.deleteApplicationAccount(accountId);
      setConfirmDeleteId(undefined);
      if (revealedFor === accountId) hideRevealed();
      setMessage({ text: "Stored credential deleted." });
      await refresh();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
      setConfirmDeleteId(undefined);
    } finally {
      setBusyId(undefined);
    }
  }

  if (status !== "signed-in") {
    return <p className="field-help">Sign in to view accounts aplyx created on your behalf.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <p className="field-help">
        aplyx stores these accounts for you — using your email or a managed alias — so an
        application-required ATS account can be reused for document uploads and status checks.
        Credentials are masked by default. Revealing, copying, rotating, or syncing one needs you
        to confirm it's you again ({hasPasswordIdentity ? "your password" : "Google sign-in"}) if you haven't recently.
      </p>

      {message ? (
        <div className={message.error ? "message-banner message-banner-error" : "message-banner"}>{message.text}</div>
      ) : null}

      <section className="settings-section">
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Connect an ATS account</h2>
        <p className="field-help">
          Workday credentials are stored in your online ATS account vault so they are available on every signed-in device.
          {root ? " This device also keeps a secure local cache for local Workday runs." : " A local cache can be added later from this screen."}
        </p>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Workday tenant hostname</span>
            <input
              value={workdayHost}
              onChange={(e) => setWorkdayHost(e.target.value)}
              placeholder="expedia.wd108.myworkdayjobs.com"
              autoComplete="organization"
            />
          </label>
          <label className="field">
            <span className="field-label">Company name</span>
            <input
              value={workdayCompany}
              onChange={(e) => setWorkdayCompany(e.target.value)}
              placeholder="Expedia Group"
              autoComplete="organization"
            />
          </label>
          <label className="field">
            <span className="field-label">Workday account email</span>
            <input
              type="email"
              value={workdayUsername}
              onChange={(e) => setWorkdayUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span className="field-label">Workday password</span>
            <input
              type="password"
              value={workdayPassword}
              onChange={(e) => setWorkdayPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Enter password"
            />
          </label>
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void saveWorkdayAccount()}
            disabled={workdaySaving || !workdayHost.trim() || !workdayCompany.trim() || !workdayUsername.trim() || !workdayPassword}
          >
            {workdaySaving ? "Saving…" : "Save to online vault"}
          </button>
          <button
            type="button"
            className="settings-action-btn"
            onClick={() => void importDeviceWorkdayAccount()}
            disabled={workdaySaving || !workdayHost.trim() || !workdayCompany.trim() || !workdayUsername.trim()}
          >
            Import from this device
          </button>
        </div>
        {workdayError ? <p className="field-help" style={{ color: "var(--danger)" }}>{workdayError}</p> : null}
      </section>

      {accounts === undefined ? (
        <p className="field-help">Loading…</p>
      ) : accounts.length === 0 ? (
        <div className="data-empty">No ATS accounts stored yet.</div>
      ) : (
        <section className="settings-section">
          {accounts.map((account) => {
            const revealed = revealedFor === account.id ? revealedCredential : undefined;
            const rowBusy = busyId === account.id;
            return (
              <div key={account.id} className="check-row" style={{ flexWrap: "wrap" }}>
                <span className={statusBadgeClass(account.status)}>{account.status.replace(/_/g, " ")}</span>
                <div style={{ flex: 1, minWidth: "12rem" }}>
                  <div className="check-label">
                    {account.company_name} — {familyLabel(account.ats_family)}
                  </div>
                  <div className="check-detail">
                    {revealed ? (
                      <span>
                        <code>{revealed.username}</code> / <code>{revealed.password}</code>
                      </span>
                    ) : (
                      <span>{account.login_hint ?? "no login recorded yet"}</span>
                    )}
                    {" · "}verification: {account.verification_status.replace(/_/g, " ")}
                    {account.last_login_at ? ` · last login ${new Date(account.last_login_at).toLocaleString()}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
                  {revealed ? (
                    <>
                      <button type="button" className="settings-action-btn" onClick={() => void copyRevealed(revealed.password, "password")}>
                        Copy password
                      </button>
                      <button type="button" className="settings-action-btn" onClick={hideRevealed}>
                        Hide
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="settings-action-btn"
                      disabled={rowBusy}
                      onClick={() => requireRecentAuth(account.id, "reveal", () => void doReveal(account.id))}
                    >
                      {rowBusy ? "Revealing…" : "Reveal"}
                    </button>
                  )}
                  {root && account.ats_family === "workday" ? (
                    <button
                      type="button"
                      className="settings-action-btn"
                      disabled={rowBusy}
                      onClick={() => requireRecentAuth(account.id, "sync", () => void syncToDevice(account))}
                    >
                      {rowBusy ? "Syncing…" : "Sync to this device"}
                    </button>
                  ) : null}
                  <button type="button" className="settings-action-btn" disabled={rowBusy} onClick={() => openRotate(account.id)}>
                    Rotate
                  </button>
                  <Switch
                    checked={account.status_tracking_enabled}
                    onChange={(checked) => void toggleTracking(account.id, checked)}
                    disabled={rowBusy}
                    pending={rowBusy}
                    label={`Status tracking for ${account.company_name}`}
                  />
                  <button
                    type="button"
                    className="settings-action-btn settings-action-btn-danger"
                    disabled={rowBusy}
                    onClick={() => setConfirmDeleteId(account.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <Modal
        open={pendingAction !== undefined}
        onClose={() => {
          setPendingAction(undefined);
          setGoogleReauthPending(false);
        }}
        title={hasPasswordIdentity ? "Confirm your password" : "Confirm with Google"}
      >
        {hasPasswordIdentity ? (
          <>
            <p className="field-help">Re-enter your password to reveal, rotate, or sync a stored credential.</p>
            <div className="field">
              <input
                type="password"
                autoComplete="current-password"
                value={reauthPassword}
                onChange={(e) => setReauthPassword(e.target.value)}
                placeholder="Password"
                autoFocus
              />
            </div>
            {reauthError ? <p className="field-help" style={{ color: "var(--danger)" }}>{reauthError}</p> : null}
            <div className="detail-actions" style={{ marginTop: "var(--space-3)" }}>
              <button type="button" className="btn btn-primary" disabled={reauthBusy || !reauthPassword} onClick={() => void confirmReauth()}>
                {reauthBusy ? "Confirming…" : "Confirm"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="field-help">
              You signed in with Google, so there's no aplyx password to re-enter. Confirming reopens Google sign-in in
              your browser. Once it completes, this picks back up automatically.
            </p>
            {reauthError ? <p className="field-help" style={{ color: "var(--danger)" }}>{reauthError}</p> : null}
            <div className="detail-actions" style={{ marginTop: "var(--space-3)" }}>
              <button type="button" className="btn btn-primary" disabled={reauthBusy || googleReauthPending} onClick={() => void confirmReauthWithGoogle()}>
                {googleReauthPending ? "Waiting for Google…" : reauthBusy ? "Opening Google…" : "Confirm with Google"}
              </button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={rotateAccountId !== undefined} onClose={() => setRotateAccountId(undefined)} title="Rotate stored credential">
        <p className="field-help">
          Use this after resetting the password directly on the ATS site — aplyx only stores what you give it here, it
          doesn't reset anything on the employer's end.
        </p>
        <div className="field">
          <input
            type="text"
            autoComplete="username"
            value={rotateUsername}
            onChange={(e) => setRotateUsername(e.target.value)}
            placeholder="Username or email"
          />
        </div>
        <div className="field">
          <input
            type="password"
            autoComplete="new-password"
            value={rotatePassword}
            onChange={(e) => setRotatePassword(e.target.value)}
            placeholder="New password"
          />
        </div>
        {rotateError ? <p className="field-help" style={{ color: "var(--danger)" }}>{rotateError}</p> : null}
        <div className="detail-actions" style={{ marginTop: "var(--space-3)" }}>
          <button type="button" className="btn btn-primary" disabled={busyId === rotateAccountId} onClick={() => void submitRotate()}>
            {busyId === rotateAccountId ? "Rotating…" : "Rotate"}
          </button>
        </div>
      </Modal>

      <Modal open={confirmDeleteId !== undefined} onClose={() => setConfirmDeleteId(undefined)} title="Delete stored credential">
        <p className="field-help">
          This permanently deletes the stored username and password for this ATS account. You'll need to create or log
          into the account manually afterward if you want to keep using it.
        </p>
        <div className="detail-actions" style={{ marginTop: "var(--space-3)" }}>
          <button type="button" className="btn btn-danger" disabled={busyId === confirmDeleteId} onClick={() => void confirmDelete()}>
            {busyId === confirmDeleteId ? "Deleting…" : "Delete"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
