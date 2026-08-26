import { useEffect, useState } from "react";
import { SupabaseAdapter, type ApplicationAccountRow } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "../../lib/AuthContext";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { Modal } from "../../components/Modal";
import { Switch } from "../../components/Switch";
import "../../components/formFields.css";
import "../../components/dataList.css";

/** ATS account credentials (docs/ats-account-credentials-plan.md
 *  Package 6). Hosted-only — application_accounts/Vault have no local
 *  equivalent (the plan's local OS-keychain design is a separate,
 *  still-open decision), so this screen renders nothing outside a
 *  signed-in session; there is no source==="local" branch to handle.
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

type PendingAction = { accountId: string; kind: "reveal" | "rotate" };

export function AccountCenterScreen() {
  const { status, session } = useAuth();
  const [accounts, setAccounts] = useState<ApplicationAccountRow[] | undefined>(undefined);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  const [lastReauthAt, setLastReauthAt] = useState<number | undefined>(undefined);
  const [pendingAction, setPendingAction] = useState<PendingAction | undefined>(undefined);
  const [reauthPassword, setReauthPassword] = useState("");
  const [reauthError, setReauthError] = useState<string | undefined>(undefined);
  const [reauthBusy, setReauthBusy] = useState(false);

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
      setLastReauthAt(Date.now());
      const action = pendingAction;
      setPendingAction(undefined);
      setReauthPassword("");
      if (action.kind === "reveal") void doReveal(action.accountId);
      if (action.kind === "rotate") setRotateAccountId(action.accountId);
    } finally {
      setReauthBusy(false);
    }
  }

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
        aplyx creates these accounts for you — using your email or a managed alias — so an
        application-required ATS account can be reused for document uploads and status checks.
        Credentials are masked by default — revealing or copying one needs your password again if
        you haven't confirmed it recently.
      </p>

      {message ? (
        <div className={message.error ? "message-banner message-banner-error" : "message-banner"}>{message.text}</div>
      ) : null}

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

      <Modal open={pendingAction !== undefined} onClose={() => setPendingAction(undefined)} title="Confirm your password">
        <p className="field-help">Re-enter your password to reveal or rotate a stored credential.</p>
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
