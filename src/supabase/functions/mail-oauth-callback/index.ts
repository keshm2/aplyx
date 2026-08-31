import { createClient } from "npm:@supabase/supabase-js@2";
import { appCallbackUrl, callbackUrl, gmailConfig, microsoftConfig, redirectWithResult, verifyState } from "../_shared/mail_oauth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAIL_OAUTH_STATE_SECRET = Deno.env.get("MAIL_OAUTH_STATE_SECRET") ?? "";

// Not just `error instanceof Error ? error.message : String(error)`: a
// PostgrestError from admin.rpc() (service_upsert_mail_connection_oauth)
// extends Error in the postgrest-js source, but Deno's npm: compat layer
// can hand back an object that fails instanceof across that boundary even
// when it has a real .message. String()'ing a plain object gives the
// literal text "[object Object]", caught live 2026-08-21: that string
// went out through redirectWithResult's message param and rendered
// verbatim in the desktop app's error banner, hiding whatever actually
// went wrong. Checking for a .message property directly works regardless
// of which path produced the error.
function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
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
  if (!MAIL_OAUTH_STATE_SECRET) return redirectWithResult("unknown", { status: "error", message: "mail oauth secret is not configured" });

  const providerError = url.searchParams.get("error");
  const rawState = url.searchParams.get("state") ?? "";
  const parsedState = await verifyState(rawState, MAIL_OAUTH_STATE_SECRET);
  const provider = String(parsedState?.provider ?? "unknown");
  if (providerError) {
    return redirectWithResult(provider, { status: "error", message: providerError });
  }
  if (!parsedState) {
    return redirectWithResult(provider, { status: "error", message: "invalid oauth state" });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return redirectWithResult(provider, { status: "error", message: "missing authorization code" });
  }
  const userId = String(parsedState.user_id ?? "").trim();
  if (!userId) {
    return redirectWithResult(provider, { status: "error", message: "missing user context" });
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
    return redirectWithResult(provider, { status: "error", message: errorMessage(error) });
  }
});
