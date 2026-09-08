import { createClient } from "npm:@supabase/supabase-js@2";
import { type MailOAuthProvider, authUrlForProvider, callbackUrl, providerEnabled, signState } from "../_shared/mail_oauth.ts";
import { badRequest, methodNotAllowed, noContent, ok, serverError, serviceUnavailable, unauthorized } from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAIL_OAUTH_STATE_SECRET = Deno.env.get("MAIL_OAUTH_STATE_SECRET") ?? "";

// This is the only Edge Function in this repo called directly from the
// browser/webview (client.functions.invoke): every other function runs
// server-to-server (cron, webhooks, OAuth redirects), so this is the only
// one that ever hits a CORS preflight. Without these headers, the desktop
// app's webview blocks the OPTIONS preflight before the real POST is even
// sent, and supabase-js surfaces that as a generic "Failed to send a
// request to the Edge Function" with no useful detail.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return noContent(CORS_HEADERS);
  if (req.method !== "POST") return methodNotAllowed(CORS_HEADERS);
  if (!MAIL_OAUTH_STATE_SECRET) {
    // Our misconfiguration, not the caller's problem: opaque 5xx, real
    // reason ("MAIL_OAUTH_STATE_SECRET unset") only in the function log.
    return serviceUnavailable("mail-oauth-start:config", "MAIL_OAUTH_STATE_SECRET unset", CORS_HEADERS);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return unauthorized(CORS_HEADERS);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userResp, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userResp.user) return unauthorized(CORS_HEADERS);

  const payload = await req.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return badRequest("invalid request body", CORS_HEADERS);
  const provider = String((payload as { provider?: string }).provider ?? "").trim() as MailOAuthProvider;
  if (provider !== "microsoft" && provider !== "gmail") {
    return badRequest("provider must be microsoft or gmail", CORS_HEADERS);
  }
  if (!providerEnabled(provider)) {
    // The provider's client credentials aren't configured on this deploy:
    // our side, nothing the caller can fix. 5xx, opaque body; the app
    // shows its own "not available yet" copy.
    return serviceUnavailable("mail-oauth-start:provider-disabled", `${provider} not configured`, CORS_HEADERS);
  }

  try {
    const state = await signState({ user_id: userResp.user.id, provider, ts: Date.now() }, MAIL_OAUTH_STATE_SECRET);
    const redirectUri = callbackUrl();
    return ok({ provider, auth_url: authUrlForProvider(provider, redirectUri, state) }, CORS_HEADERS);
  } catch (err) {
    return serverError("mail-oauth-start:sign-state", err, CORS_HEADERS);
  }
});
