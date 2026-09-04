import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useOauthBusyRecovery } from "../../../lib/useOauthBusyRecovery";
import "../../../components/formFields.css";

// Auto-fills imap_server from the email domain for common providers, so
// most users never have to know or type an IMAP hostname.
const KNOWN_IMAP_SERVERS: Record<string, string> = {
  "gmail.com": "imap.gmail.com",
  "googlemail.com": "imap.gmail.com",
  "outlook.com": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
  "live.com": "outlook.office365.com",
  "msn.com": "outlook.office365.com",
  "yahoo.com": "imap.mail.yahoo.com",
  "icloud.com": "imap.mail.me.com",
  "me.com": "imap.mail.me.com",
};

function guessImapServer(email: string): string | undefined {
  const domain = email.split("@")[1]?.toLowerCase().trim();
  return domain ? KNOWN_IMAP_SERVERS[domain] : undefined;
}

/**
 * Hosted-only inbox status tracking (docs/website.md's pricing page already
 * lists this as a Pro-tier feature; local installs have no equivalent of
 * this step at all). Submits straight to the set_email_tracking_config RPC
 * (migration 0007_hosted_email_tracking.sql); app_password is stored via
 * Supabase Vault server-side and never lands in a plain, client-readable
 * column; a scheduled Edge Function (email-tracking-worker) does the actual
 * IMAP polling, not this app.
 */
export function EmailTrackingStep({ client, userId, onComplete }: { client: SupabaseClient; userId: string; onComplete: () => void }) {
  const [provider, setProvider] = useState<"gmail" | "microsoft" | "imap">("gmail");
  const [email, setEmail] = useState("");
  const [imapServer, setImapServer] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function refreshConnection() {
    const adapter = new SupabaseAdapter(client, userId);
    const [candidateEmail, connection] = await Promise.all([adapter.readCandidateEmail(), adapter.getInboxConnection()]);
    if (candidateEmail) {
      setEmail(candidateEmail);
      const guessed = guessImapServer(candidateEmail);
      if (guessed) setImapServer(guessed);
    }
    if (connection) {
      setProvider(connection.provider);
      setEmail(connection.email_address);
      const guessed = guessImapServer(connection.email_address);
      if (guessed) setImapServer(guessed);
    }
    return connection;
  }

  useEffect(() => {
    refreshConnection()
      .then(() => {})
      .catch(() => {});
  }, [client, userId]);

  // If the consent window is closed / cancelled / the account isn't an
  // approved tester, the aplyx://mail-callback deep link never fires and
  // the button would stay stuck on "Opening consent…". Recover it when the
  // app regains focus (or after a timeout).
  const recheckConnected = useCallback(async () => {
    try {
      const c = await refreshConnection();
      return c?.status === "connected";
    } catch {
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId]);
  useOauthBusyRecovery({
    busy: saving,
    recheck: recheckConnected,
    onConnected: () => {
      setSaving(false);
      onComplete();
    },
    onGiveUp: () => {
      setSaving(false);
      setError((prev) => prev ?? "Consent wasn't completed. Click Connect to try again.");
    },
  });

  useEffect(() => {
    const unlisten = onOpenUrl(async (urls) => {
      const incoming = urls.find((u) => u.startsWith("aplyx://mail-callback"));
      if (!incoming) return;
      const url = new URL(incoming);
      const nextProvider = url.searchParams.get("provider") ?? provider;
      const status = url.searchParams.get("status") ?? "error";
      const message = url.searchParams.get("message") ?? "";
      if (status !== "connected") {
        setError(message || `${nextProvider} inbox connection failed.`);
        setSaving(false);
        return;
      }
      try {
        const connection = await refreshConnection();
        setSaving(false);
        if (connection?.status === "connected") {
          onComplete();
          return;
        }
        setError(`Returned from ${nextProvider} consent, but no inbox connection was saved.`);
      } catch (err) {
        setSaving(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [client, provider, onComplete, userId]);

  async function startOauth() {
    setSaving(true);
    setError(undefined);
    const { data, error: invokeError } = await client.functions.invoke<{ auth_url?: string; error?: string }>("mail-oauth-start", {
      body: { provider },
    });
    if (invokeError || !data?.auth_url) {
      setSaving(false);
      setError(invokeError?.message ?? data?.error ?? `${provider} inbox OAuth is not available yet.`);
      return;
    }
    await openUrl(data.auth_url);
  }

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      await new SupabaseAdapter(client, userId).saveImapInboxConnection({
        provider,
        email,
        imapServer,
        appPassword,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <p className="field-help">
        Hosted plans require inbox access for gated ATS verification. Connect Gmail via OAuth (Outlook
        OAuth support is planned), or use a read-only IMAP app password, stored encrypted in
        Supabase Vault and used only by aplyx&rsquo;s hosted worker.
      </p>

      <div className="field">
        <label className="field-label">Provider</label>
        <div className="yesno-toggle" role="group" aria-label="Provider">
          {(["gmail", "microsoft", "imap"] as const).map((value) => (
            <button key={value} type="button" className={provider === value ? "selected" : ""} onClick={() => setProvider(value)}>
              {value === "gmail" ? "Gmail" : value === "microsoft" ? "Outlook" : "Other IMAP"}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="hosted-email-address">Inbox email</label>
        <input
          id="hosted-email-address"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            const next = e.currentTarget.value;
            const guessed = guessImapServer(next);
            setEmail(next);
            if (guessed) setImapServer(guessed);
          }}
        />
      </div>

      {provider !== "imap" && (
        <>
          <p className="field-help">
            {provider === "microsoft"
              ? "Connect your Outlook inbox through Microsoft consent. aplyx will request read-only mail access for hosted verification sessions."
              : "Connect your Gmail inbox through Google consent. Gmail access may require additional provider verification depending on deployment."}
          </p>
          {error && <p className="field-help" style={{ color: "var(--danger)" }}>{error}</p>}
          <button type="button" className="wizard-next" disabled={saving || !email} onClick={() => void startOauth()}>
            {saving ? "Opening consent…" : provider === "microsoft" ? "Connect Outlook inbox" : "Connect Gmail inbox"}
          </button>
        </>
      )}

      {provider === "imap" && <div className="field">
        <label className="field-label" htmlFor="hosted-imap-server">IMAP server</label>
        <input
          id="hosted-imap-server"
          type="text"
          placeholder="imap.gmail.com"
          value={imapServer}
          onChange={(e) => setImapServer(e.currentTarget.value)}
        />
        <p className="field-help">Auto-filled for common providers. This is the required hosted inbox path today.</p>
      </div>}

      {provider === "imap" && <div className="field">
        <label className="field-label" htmlFor="hosted-app-password">App-specific password</label>
        <input
          id="hosted-app-password"
          type="password"
          placeholder="xxxx xxxx xxxx xxxx"
          value={appPassword}
          onChange={(e) => setAppPassword(e.currentTarget.value)}
        />
      </div>}

      {provider === "imap" && (
        <>
          {error && <p className="field-help" style={{ color: "var(--danger)" }}>{error}</p>}
          <button type="button" className="wizard-next" disabled={saving || !email || !imapServer || !appPassword} onClick={() => void save()}>
            {saving ? "Connecting…" : "Connect inbox"}
          </button>
        </>
      )}
    </div>
  );
}
