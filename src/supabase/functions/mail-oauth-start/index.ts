import { createClient } from "npm:@supabase/supabase-js@2";
import { type MailOAuthProvider, authUrlForProvider, callbackUrl, providerEnabled, signState } from "../_shared/mail_oauth.ts";

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!MAIL_OAUTH_STATE_SECRET) return json({ error: "MAIL_OAUTH_STATE_SECRET is not configured" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "missing bearer token" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userResp, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userResp.user) return json({ error: userError?.message ?? "not authenticated" }, 401);

  const payload = await req.json().catch(() => ({}));
  const provider = String((payload as { provider?: string }).provider ?? "").trim() as MailOAuthProvider;
  if (provider !== "microsoft" && provider !== "gmail") return json({ error: "provider must be microsoft or gmail" }, 400);
  if (!providerEnabled(provider)) return json({ error: `${provider} inbox OAuth is not enabled on this build yet` }, 501);

  const state = await signState({ user_id: userResp.user.id, provider, ts: Date.now() }, MAIL_OAUTH_STATE_SECRET);
  const redirectUri = callbackUrl();
  return json({ provider, auth_url: authUrlForProvider(provider, redirectUri, state) });
});
