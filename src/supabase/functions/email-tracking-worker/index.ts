// email-tracking-worker — hosted-only inbox status tracking (Phase 17
// follow-on, 2026-08-19). Runs on a schedule (pg_cron + pg_net, see
// migration 0009) rather than per-request; each invocation connects,
// read-only, to every opted-in hosted account's own mailbox over IMAP,
// looks for replies to jobs that account actually applied to, and
// updates `applied_jobs.outcome_status` directly (the terminal-state
// guard is enforced by a DB trigger, not by this function's own logic —
// see migration 0007).
//
// This REPLACES the earlier forwarding-based (Resend) and local-IMAP
// designs explored the same day: local installs have no access to this
// feature at all now (matches docs/website.md's pricing page, which
// already lists this as a hosted-only Pro-tier feature), and hosted
// credentials never leave Supabase's own infrastructure — the app
// password is stored via Vault (migration 0007's
// set_email_tracking_config RPC), decrypted only inside
// get_enabled_email_tracking_configs() (migration 0008, service_role-
// only), and used here strictly to open a read-only IMAP session.
//
// Required secrets (set via `supabase secrets set`):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — provided automatically by
//   the Edge Functions runtime.
//   CRON_SECRET — a random, purpose-scoped value (NOT the service-role
//   key) that migration 0009's pg_cron job also holds (via Vault, secret
//   name "cron_worker_secret") and sends as the x-cron-secret header.
//   Deliberately not reusing the real service-role key as the invocation
//   credential here, even though this function's own Supabase calls do
//   use it internally.
//
// Deploy: supabase functions deploy email-tracking-worker --no-verify-jwt
// (same reasoning as inbound-email: the caller is pg_net, not a
// Supabase-session client, so there's no platform JWT to verify —
// auth is the x-cron-secret check below instead, fail closed.)

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

import { ImapFlow, type FetchMessageObject } from "npm:imapflow@1";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Already set on this project for mail-oauth-start/callback — the OAuth
// client credentials are project-wide secrets, not per-function, so
// nothing new to configure to refresh tokens here too.
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

// Checked in this order — REJECTED first since it's the most
// linguistically distinct (explicit negation), and some rejection
// templates also contain a bare "move forward" phrase that would
// otherwise false-positive into INTERVIEW if checked first. First
// matching category wins. Ported verbatim from the local design's
// check_inbox_status.py (deterministic keyword vocabulary, never an LLM
// call).
const REJECTED_PATTERNS = [
  /not\s+(?:be\s+)?mov(?:e|ing)\s+forward/,
  /decided not to (?:proceed|move forward)/,
  /will not be (?:moving forward|proceeding)/,
  /regret to inform/,
  /not (?:been )?selected/,
  /pursu(?:e|ing) other candidates/,
  /unable to (?:offer|extend)/,
  /position (?:has been|was) filled/,
  /decided to (?:go|move) (?:with|forward with) (?:other|another)/,
  /not able to move forward/,
];
const OFFER_PATTERNS = [
  /pleased to offer/,
  /offer of employment/,
  /extend (?:you |an )?(?:an )?offer/,
  /welcome to the team/,
  /congratulations.{0,40}offer/,
];
// Checked before OA_SENT below — a submission-confirmation email ("you
// have completed the assessment") and an invitation email ("please
// complete the assessment") share enough vocabulary (assessment,
// complete) that OA_SENT's own /complete (?:the|this|an?) (?:assessment|
// assignment)/ pattern would false-positive-match a completion email if
// checked first. These patterns are specifically about confirmation
// language a real invite would never use.
const OA_COMPLETED_PATTERNS = [
  /(?:have|has) completed (?:the|your|this) (?:assessment|assignment|challenge)/,
  /(?:assessment|assignment|challenge|submission) (?:has been |was )?successfully submitted/,
  /we(?:'ve| have) received your (?:completed )?(?:assessment|assignment|submission)/,
  /thank you for completing/,
  /your (?:responses|results|answers) have been (?:recorded|submitted)/,
];
const OA_SENT_PATTERNS = [
  /online assessment/,
  /coding challenge/,
  /hackerrank/,
  /codesignal/,
  /coderpad/,
  /take-?home (?:assignment|assessment|challenge|project)/,
  /complete (?:the|this|an?) (?:assessment|assignment)/,
];
const INTERVIEW_PATTERNS = [
  /schedule (?:an|a) interview/,
  /interview invitation/,
  /next steps? (?:in|for) (?:the|your) (?:process|application)/,
  /would like to (?:speak|chat|connect) with you/,
  /phone screen/,
  /technical interview/,
  /schedule (?:a )?(?:call|chat)/,
  /move forward with your application/,
];

const PHASE_PATTERNS: [string, RegExp[]][] = [
  ["rejected", REJECTED_PATTERNS],
  ["offer", OFFER_PATTERNS],
  ["oa_completed", OA_COMPLETED_PATTERNS],
  ["oa_sent", OA_SENT_PATTERNS],
  ["interview_requested", INTERVIEW_PATTERNS],
];

function classify(text: string): string | undefined {
  const lowered = text.toLowerCase();
  for (const [phase, patterns] of PHASE_PATTERNS) {
    if (patterns.some((re) => re.test(lowered))) return phase;
  }
  return undefined;
}

// Only pulled when classify() returns "oa_sent" (operator request,
// 2026-08-21) — the desktop app shows these as "Open assessment link" and
// "Duration to complete" on that job's detail sheet. Best-effort, same
// deterministic-regex spirit as classify() itself: no attempt to parse a
// real deadline out of wildly inconsistent phrasing ("active for 7 days",
// "complete by August 30", "within 72 hours") — the matched phrase is
// stored verbatim (outcome_source already sets this precedent for
// "here's what we matched, not a verified fact").
function extractAssessmentUrl(text: string): string | undefined {
  const urls = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const NOISE = /unsubscribe|opt-?out|preferences|privacy-?policy|tracking\.|\/pixel/i;
  return urls.find((u) => !NOISE.test(u));
}

const ASSESSMENT_DURATION_PATTERNS = [
  /(?:valid|active|available)\s+for\s+([^.\n,;]{1,40})/i,
  /within\s+(\d+\s*(?:hours?|days?))/i,
  /expires?\s+(?:in|on)\s+([^.\n,;]{1,40})/i,
  /complete\s+(?:it\s+|this\s+)?by\s+([^.\n,;]{1,40})/i,
  /deadline\s*(?:is|:)?\s*([^.\n,;]{1,40})/i,
];

function extractAssessmentDuration(text: string): string | undefined {
  for (const re of ASSESSMENT_DURATION_PATTERNS) {
    const match = text.match(re);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

interface EnabledConfig {
  user_id: string;
  email: string;
  imap_server: string;
  imap_port: number;
  app_password: string;
  last_uid: number;
}

async function processAccount(
  supabase: ReturnType<typeof createClient>,
  cfg: EnabledConfig,
): Promise<{ user_id: string; messages_seen: number; events_written: number; error?: string }> {
  const { data: appliedRows, error: appliedErr } = await supabase
    .from("applied_jobs")
    .select("job_id, company")
    .eq("user_id", cfg.user_id);
  if (appliedErr) {
    return { user_id: cfg.user_id, messages_seen: 0, events_written: 0, error: appliedErr.message };
  }
  const companies = (appliedRows ?? []).filter((r) => (r.company as string ?? "").trim().length >= 3);
  if (companies.length === 0) {
    return { user_id: cfg.user_id, messages_seen: 0, events_written: 0 };
  }

  const client = new ImapFlow({
    host: cfg.imap_server,
    port: cfg.imap_port,
    secure: true,
    auth: { user: cfg.email, pass: cfg.app_password },
    logger: false,
  });

  let messagesSeen = 0;
  let eventsWritten = 0;
  let highestUid = cfg.last_uid;

  try {
    await client.connect();
    // readOnly: true -- the server itself refuses any state-changing
    // command for this session, not just an application-level promise.
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const range = `${cfg.last_uid + 1}:*`;
      for await (const msg of client.fetch(range, { uid: true, envelope: true }) as AsyncIterable<FetchMessageObject>) {
        if (!msg.uid || msg.uid <= cfg.last_uid) continue;
        messagesSeen++;
        if (msg.uid > highestUid) highestUid = msg.uid;

        const from = msg.envelope?.from?.[0]?.address ?? "";
        const subject = msg.envelope?.subject ?? "";
        const fromLower = from.toLowerCase();
        const subjectLower = subject.toLowerCase();

        const matched = companies.find((c) => {
          const name = String(c.company).trim().toLowerCase();
          return fromLower.includes(name) || subjectLower.includes(name);
        });
        if (!matched) continue;

        const bodyMsg = await client.fetchOne(String(msg.uid), { uid: true, bodyParts: ["text"] });
        const bodyText =
          bodyMsg && bodyMsg.bodyParts ? new TextDecoder().decode(bodyMsg.bodyParts.get("text") ?? new Uint8Array()) : "";
        const combinedText = `${subject}\n${bodyText}`;
        const phase = classify(combinedText);
        if (!phase) continue;

        const { error: updateErr } = await supabase
          .from("applied_jobs")
          .update({
            outcome_status: phase,
            outcome_updated_at: new Date().toISOString(),
            outcome_source: `email:${subject.slice(0, 200)}`,
            ...(phase === "oa_sent"
              ? {
                  outcome_assessment_url: extractAssessmentUrl(combinedText) ?? null,
                  outcome_assessment_note: extractAssessmentDuration(combinedText) ?? null,
                }
              : {}),
          })
          .eq("user_id", cfg.user_id)
          .eq("job_id", matched.job_id);
        // The DB trigger silently keeps a terminal outcome_status in
        // place rather than erroring, so a successful update here can
        // still be a no-op -- that's correct behavior, not logged as a
        // failure.
        if (!updateErr) eventsWritten++;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    try {
      await client.logout();
    } catch {
      // already disconnected
    }
    return { user_id: cfg.user_id, messages_seen: messagesSeen, events_written: eventsWritten, error: String(err) };
  }

  if (highestUid > cfg.last_uid) {
    await supabase.from("email_tracking_config").update({ last_uid: highestUid }).eq("user_id", cfg.user_id);
  }

  return { user_id: cfg.user_id, messages_seen: messagesSeen, events_written: eventsWritten };
}

interface OAuthGmailConfig {
  connection_id: string;
  user_id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  watch_state: Record<string, unknown> | null;
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) throw new Error(`Google token refresh failed: HTTP ${resp.status}`);
  const data = await resp.json();
  return String(data.access_token ?? "");
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Gmail API messages are a MIME tree, not a flat body — walks it looking
// for the first text/plain part (falls back to a tag-stripped text/html
// part if that's all the message has), same "subject + body text" input
// classify() already expects from the IMAP path.
interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function extractPlainText(payload: GmailPart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]+>/g, " ");
  }
  return "";
}

async function processOAuthGmailAccount(
  supabase: ReturnType<typeof createClient>,
  cfg: OAuthGmailConfig,
): Promise<{ user_id: string; messages_seen: number; events_written: number; error?: string }> {
  const { data: appliedRows, error: appliedErr } = await supabase
    .from("applied_jobs")
    .select("job_id, company")
    .eq("user_id", cfg.user_id);
  if (appliedErr) {
    return { user_id: cfg.user_id, messages_seen: 0, events_written: 0, error: appliedErr.message };
  }
  const companies = (appliedRows ?? []).filter((r) => (r.company as string ?? "").trim().length >= 3);
  if (companies.length === 0) {
    return { user_id: cfg.user_id, messages_seen: 0, events_written: 0 };
  }

  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(cfg.refresh_token);
    await supabase.rpc("service_update_mail_connection_access_token", {
      p_connection_id: cfg.connection_id,
      p_access_token: accessToken,
    });
  } catch (err) {
    return {
      user_id: cfg.user_id,
      messages_seen: 0,
      events_written: 0,
      error: `token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Unlike IMAP's uid-based cursor, Gmail's search API is timestamp-based
  // (Gmail search's "after:" only has day granularity, not seconds — a
  // day of overlap on every run is deliberate, not a bug: re-matching an
  // already-classified email is a harmless no-op, since applied_jobs'
  // terminal-state trigger (migration 0007) keeps a resolved outcome_status
  // in place regardless of how many times this runs). 0 means "never run
  // before" -- no after: filter, scans the account's whole matching history.
  const lastCheckedAt = typeof cfg.watch_state?.last_checked_at === "string" ? (cfg.watch_state.last_checked_at as string) : undefined;
  const afterEpoch = lastCheckedAt ? Math.floor(new Date(lastCheckedAt).getTime() / 1000) : 0;
  const runStartedAt = new Date().toISOString();

  let messagesSeen = 0;
  let eventsWritten = 0;

  try {
    for (const c of companies) {
      const name = String(c.company).trim();
      const query = afterEpoch > 0 ? `(from:"${name}" OR subject:"${name}") after:${afterEpoch}` : `(from:"${name}" OR subject:"${name}")`;
      const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      listUrl.searchParams.set("q", query);
      listUrl.searchParams.set("maxResults", "20");
      const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      // Best-effort per company — one bad/rate-limited query shouldn't
      // abort the whole account's scan.
      if (!listResp.ok) continue;
      const listData = await listResp.json();
      const ids: string[] = ((listData.messages ?? []) as { id: string }[]).map((m) => m.id);

      for (const id of ids) {
        messagesSeen++;
        const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!msgResp.ok) continue;
        const msg = await msgResp.json();
        const headers: { name: string; value: string }[] = msg.payload?.headers ?? [];
        const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
        const bodyText = extractPlainText(msg.payload);
        const combinedText = `${subject}\n${bodyText}`;
        const phase = classify(combinedText);
        if (!phase) continue;

        const { error: updateErr } = await supabase
          .from("applied_jobs")
          .update({
            outcome_status: phase,
            outcome_updated_at: new Date().toISOString(),
            outcome_source: `email:${subject.slice(0, 200)}`,
            ...(phase === "oa_sent"
              ? {
                  outcome_assessment_url: extractAssessmentUrl(combinedText) ?? null,
                  outcome_assessment_note: extractAssessmentDuration(combinedText) ?? null,
                }
              : {}),
          })
          .eq("user_id", cfg.user_id)
          .eq("job_id", c.job_id);
        if (!updateErr) eventsWritten++;
      }
    }
  } catch (err) {
    return {
      user_id: cfg.user_id,
      messages_seen: messagesSeen,
      events_written: eventsWritten,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await supabase.rpc("service_update_mail_connection_watch_state", {
    p_connection_id: cfg.connection_id,
    p_watch_state: { ...(cfg.watch_state ?? {}), last_checked_at: runStartedAt },
  });

  return { user_id: cfg.user_id, messages_seen: messagesSeen, events_written: eventsWritten };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: configs, error } = await supabase.rpc("get_enabled_email_tracking_configs");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results = [];
  for (const cfg of (configs ?? []) as EnabledConfig[]) {
    results.push(await processAccount(supabase, cfg));
  }

  // OAuth Gmail connections (mail_connections) — a separate accessor since
  // they're a different table with a different decrypted-secret shape
  // than email_tracking_config's app-password rows above. A failure here
  // (e.g. the RPC not existing yet on an older deploy) doesn't block the
  // app-password accounts that already worked.
  const { data: oauthConfigs, error: oauthError } = await supabase.rpc("get_enabled_oauth_mail_connections");
  const oauthResults = [];
  if (!oauthError) {
    for (const cfg of (oauthConfigs ?? []) as OAuthGmailConfig[]) {
      oauthResults.push(await processOAuthGmailAccount(supabase, cfg));
    }
  }

  return new Response(
    JSON.stringify({
      accounts_processed: results.length + oauthResults.length,
      results,
      oauth_results: oauthResults,
      oauth_error: oauthError?.message,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
