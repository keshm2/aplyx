import { createClient } from "npm:@supabase/supabase-js@2";
import { appCallbackUrl, callbackUrl, gmailConfig, microsoftConfig, redirectWithResult, verifyState } from "../_shared/mail_oauth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAIL_OAUTH_STATE_SECRET = Deno.env.get("MAIL_OAUTH_STATE_SECRET") ?? "";

// This endpoint can only ever redirect (the browser lands here from the
// provider's consent screen and must bounce back into the app), so every
// path returns a 302 — 3xx is exactly right here. What it must NOT do is
// carry an internal error into the `message` param: that string renders
// verbatim in the desktop app's error banner. So every failure maps to
// one of a few fixed, user-safe messages; the real cause (a token
// exchange HTTP status, a Postgrest error, a "[object Object]" from the
// npm: compat boundary) is logged and never leaves this function.
const SAFE_MESSAGES = {
  declined: "Authorization was declined or cancelled.",
  badLink: "The sign-in link was invalid or expired. Start the connection again.",
  failed: "Couldn't finish connecting your inbox. Try again in a moment.",
} as const;

function logCause(label: string, cause: unknown): void {
  console.error(`[mail-oauth-callback:${label}]`, cause instanceof Error ? (cause.stack ?? cause.message) : cause);
}

async function exchangeMicrosoft(code: string, redirectUri: string) {
  const cfg = microsoftConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access Mail.Read",
  });
  const tokenResp = await fetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResp.ok) throw new Error(`Microsoft token exchange failed: HTTP ${tokenResp.status}`);
  const token = await tokenResp.json();
  const meResp = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meResp.ok) throw new Error(`Microsoft profile fetch failed: HTTP ${meResp.status}`);
  const me = await meResp.json();
  return {
    email: String(me.mail || me.userPrincipalName || ""),
    providerAccountId: String(me.id || ""),
    accessToken: String(token.access_token || ""),
    refreshToken: String(token.refresh_token || ""),
    scopes: String(token.scope || "").split(/\s+/).filter(Boolean),
  };
}

async function exchangeGoogle(code: string, redirectUri: string) {
  const cfg = gmailConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResp.ok) throw new Error(`Google token exchange failed: HTTP ${tokenResp.status}`);
  const token = await tokenResp.json();
  const profileResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResp.ok) throw new Error(`Google profile fetch failed: HTTP ${profileResp.status}`);
  const profile = await profileResp.json();
  return {
    email: String(profile.email || ""),
    providerAccountId: String(profile.sub || ""),
    accessToken: String(token.access_token || ""),
    refreshToken: String(token.refresh_token || ""),
    scopes: String(token.scope || "").split(/\s+/).filter(Boolean),
  };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!MAIL_OAUTH_STATE_SECRET) {
    logCause("config", "MAIL_OAUTH_STATE_SECRET unset");
    return redirectWithResult("unknown", { status: "error", message: SAFE_MESSAGES.failed });
  }

  const providerError = url.searchParams.get("error");
  const rawState = url.searchParams.get("state") ?? "";
  const parsedState = await verifyState(rawState, MAIL_OAUTH_STATE_SECRET);
  const provider = String(parsedState?.provider ?? "unknown");
  if (providerError) {
    // access_denied / consent_required / etc. — the user's own choice at
    // the consent screen, not our failure. Logged raw, shown as generic.
    logCause("provider-error", providerError);
    return redirectWithResult(provider, { status: "error", message: SAFE_MESSAGES.declined });
  }
  if (!parsedState) {
    return redirectWithResult(provider, { status: "error", message: SAFE_MESSAGES.badLink });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return redirectWithResult(provider, { status: "error", message: SAFE_MESSAGES.badLink });
  }
  const userId = String(parsedState.user_id ?? "").trim();
  if (!userId) {
    return redirectWithResult(provider, { status: "error", message: SAFE_MESSAGES.badLink });
  }

  try {
    const redirectUri = callbackUrl();
    const tokens = provider === "microsoft"
      ? await exchangeMicrosoft(code, redirectUri)
      : await exchangeGoogle(code, redirectUri);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await admin.rpc("service_upsert_mail_connection_oauth", {
      p_user_id: userId,
      p_provider: provider,
      p_email_address: tokens.email,
      p_provider_account_id: tokens.providerAccountId,
      p_scopes: tokens.scopes,
      p_access_token: tokens.accessToken,
      p_refresh_token: tokens.refreshToken,
    });
    if (error) throw error;
    return redirectWithResult(provider, { status: "connected", email: tokens.email, callback: appCallbackUrl() });
  } catch (error) {
    logCause("exchange", error);
    return redirectWithResult(provider, { status: "error", message: SAFE_MESSAGES.failed });
  }
});
