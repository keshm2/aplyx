// workday-verification-worker — hosted Gmail verification ingestion for
// active Workday sessions (docs/workday-personal-inbox-plan.md).
//
// This is a SEPARATE function from email-tracking-worker (the post-
// application outcome tracker) on purpose: that worker classifies replies
// to already-applied jobs and writes applied_jobs.outcome_status; this one
// resolves the account-creation/verification mail a Workday apply flow
// needs BEFORE any application is submitted. They share the same OAuth
// refresh-token path and Gmail read-only scope, but never the same
// correlation logic, the same tables, or the same outcome — confusing them
// would either hand an employer reply to a verification flow or record a
// verification code as an application outcome. Safe utilities (token
// refresh, MIME plain-text extraction) are duplicated narrowly rather than
// shared across a network boundary Edge Functions can't cross.
//
// Required secrets (set via `supabase secrets set`):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — provided automatically.
//   CRON_SECRET — purpose-scoped; the pg_cron job (migration 0039) sends
//   it as x-cron-secret. NOT the service-role key.
//
// Deploy: supabase functions deploy workday-verification-worker --no-verify-jwt
// (caller is pg_net, not a Supabase-session client — same reasoning as
// email-tracking-worker. NOT deployed by this change; needs a separate
// explicit go-ahead before `supabase functions deploy`.)

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

import { createClient } from "npm:@supabase/supabase-js@2";
import { timingSafeEqual } from "../_shared/timingSafeEqual.ts";
import {
  correlate,
  detectManualRequired,
  extractLink,
  extractOtp,
  extractPlainText,
  redactSnippet,
  redactSubject,
  type ActiveSession,
} from "./worker_logic.ts";

// Bounded search window: a verification mail is only useful within a few
// minutes of account creation. Gmail's "after:" is day-granularity, so we
// search the last 2 days and rely on session correlation (recipient +
// tenant + sender/subject tokens) to reject unrelated mail — never on the
// time window alone. A session past its expires_at is excluded by the RPC.
const SEARCH_AFTER_DAYS = 2;
const MAX_MESSAGES_PER_SESSION = 10;


async function refreshGoogleAccessToken(
  refreshToken: string,
  supabase: ReturnType<typeof createClient>,
  connectionId: string,
): Promise<string> {
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
  // Google does not always return a new refresh_token, but when it does
  // (e.g. the first refresh after a grant, or rotation policies), the old
  // one may be invalidated — persist the new one or lose the connection.
  const newRefreshToken = String(data.refresh_token ?? "");
  if (newRefreshToken && newRefreshToken !== refreshToken) {
    await supabase.rpc("service_update_mail_connection_refresh_token", {
      p_connection_id: connectionId,
      p_refresh_token: newRefreshToken,
    });
  }
  return String(data.access_token ?? "");
}



async function processSession(
  supabase: ReturnType<typeof createClient>,
  session: ActiveSession,
): Promise<{ session_id: string; messages_scanned: number; outcome: string; error?: string }> {
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(session.refresh_token, supabase, session.connection_id);
    await supabase.rpc("service_update_mail_connection_access_token", {
      p_connection_id: session.connection_id,
      p_access_token: accessToken,
    });
  } catch (err) {
    await supabase.rpc("service_update_verification_session_status", {
      p_session_id: session.session_id,
      p_status: "failed",
      p_failure_reason: `token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { session_id: session.session_id, messages_scanned: 0, outcome: "failed", error: "token refresh failed" };
  }

  const afterEpoch = Math.floor((Date.now() - SEARCH_AFTER_DAYS * 86400_000) / 1000);
  // Search by recipient (the candidate's own address) plus verification
  // keywords; correlation narrows the result set further.
  const query = `to:${session.candidate_email} (verify OR verification OR code OR account) after:${afterEpoch}`;
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("maxResults", String(MAX_MESSAGES_PER_SESSION));
  let listResp: Response;
  try {
    listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    return { session_id: session.session_id, messages_scanned: 0, outcome: "error", error: String(err) };
  }
  if (!listResp.ok) {
    return { session_id: session.session_id, messages_scanned: 0, outcome: "error", error: `gmail list HTTP ${listResp.status}` };
  }
  const listData = await listResp.json();
  const ids: string[] = ((listData.messages ?? []) as { id: string }[]).map((m) => m.id);

  const candidates: { messageId: string; receivedAt: string; from: string; subject: string; body: string; score: number; reason: string }[] = [];
  for (const id of ids) {
    const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full&metadataHeaders=To&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!msgResp.ok) continue;
    const msg = await msgResp.json();
    const headers: { name: string; value: string }[] = msg.payload?.headers ?? [];
    const to = headers.find((h) => h.name.toLowerCase() === "to")?.value ?? session.candidate_email;
    const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
    const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
    const dateHeader = headers.find((h) => h.name.toLowerCase() === "date")?.value;
    const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();
    const body = extractPlainText(msg.payload);
    const corr = correlate({ to, from, subject, body }, session);
    if (!corr.matched) continue;
    candidates.push({ messageId: id, receivedAt, from, subject, body, score: corr.score, reason: corr.reason });
  }

  if (candidates.length === 0) {
    return { session_id: session.session_id, messages_scanned: ids.length, outcome: "no_match" };
  }

  // Prefer the newest message when correlation is otherwise equal. Workday
  // can issue a replacement code after an invalid/expired attempt; treating
  // the old and new messages as permanently ambiguous would strand retries.
  // Messages with indistinguishable score and timestamp remain manual.
  candidates.sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (Math.abs(scoreDelta) > 0.01) return scoreDelta;
    return Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
  });
  const best = candidates[0];
  const ambiguous = candidates.length > 1 &&
    Math.abs(best.score - candidates[1].score) < 0.01 &&
    Date.parse(best.receivedAt) === Date.parse(candidates[1].receivedAt);

  const combined = `${best.subject}\n${best.body}`;
  const manual = detectManualRequired(combined);
  if (manual) {
    await supabase.rpc("service_record_verification_message", {
      p_session_id: session.session_id,
      p_provider_message_id: best.messageId,
      p_received_at: best.receivedAt,
      p_from_address: best.from,
      p_subject_redacted: redactSubject(best.subject),
      p_snippet_redacted: `${manual}: ${redactSnippet(best.body)}`,
      p_match_score: best.score,
      p_extracted_kind: null,
      p_secret_value: null,
    });
    return { session_id: session.session_id, messages_scanned: ids.length, outcome: "manual_required" };
  }

  if (ambiguous) {
    await supabase.rpc("service_record_verification_message", {
      p_session_id: session.session_id,
      p_provider_message_id: best.messageId,
      p_received_at: best.receivedAt,
      p_from_address: best.from,
      p_subject_redacted: redactSubject(best.subject),
      p_snippet_redacted: `ambiguous: ${candidates.length} equally-correlated messages; ${redactSnippet(best.body)}`,
      p_match_score: best.score,
      p_extracted_kind: null,
      p_secret_value: null,
    });
    return { session_id: session.session_id, messages_scanned: ids.length, outcome: "manual_required" };
  }

  // Extract per challenge type. For 'either', prefer a link when the
  // session's tenant typically sends links, else an OTP; both are tried.
  const link = extractLink(combined);
  const otp = extractOtp(combined);
  let kind: string | null = null;
  let secret: string | null = null;
  if (session.challenge_type === "link" && link) {
    kind = "link";
    secret = link;
  } else if (session.challenge_type === "otp" && otp) {
    kind = "otp";
    secret = otp;
  } else if (session.challenge_type === "either" || session.challenge_type === "unknown") {
    if (link) {
      kind = "link";
      secret = link;
    } else if (otp) {
      kind = "otp";
      secret = otp;
    }
  }

  if (!kind || !secret) {
    // Correlated message but no extractable secret and no manual-required
    // signal — still manual_required, never guess.
    await supabase.rpc("service_record_verification_message", {
      p_session_id: session.session_id,
      p_provider_message_id: best.messageId,
      p_received_at: best.receivedAt,
      p_from_address: best.from,
      p_subject_redacted: redactSubject(best.subject),
      p_snippet_redacted: `no secret extracted; ${redactSnippet(best.body)}`,
      p_match_score: best.score,
      p_extracted_kind: null,
      p_secret_value: null,
    });
    return { session_id: session.session_id, messages_scanned: ids.length, outcome: "manual_required" };
  }

  await supabase.rpc("service_record_verification_message", {
    p_session_id: session.session_id,
    p_provider_message_id: best.messageId,
    p_received_at: best.receivedAt,
    p_from_address: best.from,
    p_subject_redacted: redactSubject(best.subject),
    p_snippet_redacted: redactSnippet(best.body),
    p_match_score: best.score,
    p_extracted_kind: kind,
    p_secret_value: secret,
  });
  return { session_id: session.session_id, messages_scanned: ids.length, outcome: "secret_ready" };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const providedSecret = req.headers.get("x-cron-secret");
  if (!CRON_SECRET || !providedSecret || !(await timingSafeEqual(providedSecret, CRON_SECRET))) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error: cleanupError } = await supabase.rpc("service_cleanup_expired_verification_secrets");
  if (cleanupError) {
    return new Response(JSON.stringify({ error: "verification secret cleanup failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { data: sessions, error } = await supabase.rpc("service_list_active_workday_sessions");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results = [];
  for (const session of (sessions ?? []) as ActiveSession[]) {
    // Best-effort per session — one bad refresh/search shouldn't abort
    // the whole scan, same posture as email-tracking-worker.
    try {
      results.push(await processSession(supabase, session));
    } catch (err) {
      results.push({
        session_id: session.session_id,
        messages_scanned: 0,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new Response(
    JSON.stringify({ sessions_processed: results.length, results }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
