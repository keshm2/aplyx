export type MailOAuthProvider = "microsoft" | "gmail";

function base64UrlEncode(input: Uint8Array): string {
  const text = btoa(String.fromCharCode(...input));
  return text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4 || 4)) % 4);
  const text = atob(base64);
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(sig));
}

export async function signState(payload: Record<string, unknown>, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const encoded = base64UrlEncode(new TextEncoder().encode(json));
  const signature = await hmac(secret, encoded);
  return `${encoded}.${signature}`;
}

export async function verifyState(state: string, secret: string): Promise<Record<string, unknown> | null> {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;
  const expected = await hmac(secret, encoded);
  if (expected !== signature) return null;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(encoded));
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Deliberately NOT derived from the incoming request's own URL: Supabase's
// edge network doesn't guarantee req.url reflects the public invoke URL
// (in practice it's the internal /functions/v1/<name> form supabase-js
// actually calls, not the project's own base), and this value MUST match
// byte-for-byte both the redirect_uri Google receives at consent time and
// the one this callback later sends back during token exchange; a
// mismatch fails as "invalid_request" on Google's side with no useful
// detail. SUPABASE_URL is the one stable, always-correct value available.
export function callbackUrl(): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return `${base}/functions/v1/mail-oauth-callback`;
}

export function appCallbackUrl(): string {
  return Deno.env.get("MAIL_CALLBACK_URL") ?? "aplyx://mail-callback";
}

export function microsoftConfig() {
  return {
    clientId: Deno.env.get("MICROSOFT_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("MICROSOFT_CLIENT_SECRET") ?? "",
    tenant: Deno.env.get("MICROSOFT_TENANT_ID") ?? "common",
  };
}

export function gmailConfig() {
  return {
    clientId: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
  };
}

export function providerEnabled(provider: MailOAuthProvider): boolean {
  if (provider === "microsoft") {
    const cfg = microsoftConfig();
    return Boolean(cfg.clientId && cfg.clientSecret);
  }
  const cfg = gmailConfig();
  return Boolean(cfg.clientId && cfg.clientSecret);
}

export function authUrlForProvider(provider: MailOAuthProvider, redirectUri: string, state: string): string {
  if (provider === "microsoft") {
    const cfg = microsoftConfig();
    const scopes = ["openid", "profile", "email", "offline_access", "Mail.Read"].join(" ");
    const url = new URL(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }
  const cfg = gmailConfig();
  const scopes = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"].join(" ");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export async function redirectWithResult(provider: string, params: Record<string, string>): Promise<Response> {
  const url = new URL(appCallbackUrl());
  url.searchParams.set("provider", provider);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url.toString(), 302);
}
