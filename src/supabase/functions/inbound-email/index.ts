import { createClient } from "npm:@supabase/supabase-js@2";
import { badRequest, methodNotAllowed, ok, serverError, serviceUnavailable, unauthorized } from "../_shared/http.ts";
import { timingSafeEqual } from "../_shared/timingSafeEqual.ts";
import { verifySvix } from "../_shared/verifySvix.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
// Resend's inbound endpoint signs with Svix headers; RESEND_INBOUND_SECRET
// is the `whsec_...` value from the endpoint's settings. INBOUND_WEBHOOK_
// SECRET is the older manual shared-secret path, kept as a fallback for a
// caller that sets the header directly. At least one must be configured.
const RESEND_INBOUND_SECRET = Deno.env.get("RESEND_INBOUND_SECRET") ?? "";
const INBOUND_WEBHOOK_SECRET = Deno.env.get("INBOUND_WEBHOOK_SECRET") ?? "";
const FORWARD_FROM = Deno.env.get("FORWARD_FROM") ?? "aplyx-mail@mail.aplyx.app";
// Plain-forward addresses on the apex (support@aplyx.app etc.), distinct
// from the managed ATS aliases on mail.aplyx.app below. Mail here just
// gets relayed to a human inbox; no DB, no OTP parsing, no alias lookup.
const SUPPORT_FORWARD_TO = Deno.env.get("SUPPORT_FORWARD_TO") ?? "";
const SUPPORT_LOCALPARTS = new Set(
  (Deno.env.get("SUPPORT_LOCALPARTS") ?? "support,hello,privacy,security,abuse")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

interface InboundPayload {
  type?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
  };
}

function extractFirstTo(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

function localPart(address: string): string {
  return address.split("@")[0]?.trim().toLowerCase() ?? "";
}

function domainPart(address: string): string {
  return address.split("@")[1]?.trim().toLowerCase() ?? "";
}

/** Relay a plain support-mailbox message to a human inbox. reply_to is
 *  the original sender so hitting reply in that inbox goes back to them
 *  directly, not to Resend. */
async function forwardToInbox(to: string, fromAddress: string, subject: string, text: string, aliasAddress: string): Promise<void> {
  if (!RESEND_API_KEY || !to) return;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FORWARD_FROM,
      to: [to],
      reply_to: fromAddress || undefined,
      subject: `[${aliasAddress}] ${subject || "(no subject)"}`,
      text: `From: ${fromAddress || "unknown"}\nTo: ${aliasAddress}\n\n${text}`,
    }),
  });
  if (!resp.ok) throw new Error(`Resend forward failed: HTTP ${resp.status}`);
}

function extractOtp(text: string): string | undefined {
  const match = text.match(/\b(?:code|otp|verification code)\D{0,20}(\d{4,8})\b/i) ?? text.match(/\b(\d{6})\b/);
  return match?.[1];
}

function extractLink(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s<>"]+/i)?.[0];
}

async function forwardEmail(to: string, subject: string, text: string, aliasAddress: string): Promise<void> {
  if (!RESEND_API_KEY) return;
  const body = {
    from: FORWARD_FROM,
    to: [to],
    subject: `[Aplyx ATS Mail] ${subject || "ATS message"}`,
    text: `Forwarded from ${aliasAddress}\n\n${text}`,
  };
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Resend forward failed: HTTP ${resp.status}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return methodNotAllowed();

  const rawBody = await req.text();

  // Fail closed: with no auth secret configured, anyone who can reach
  // this URL could inject forged inbound mail (fake OTPs/links) for any
  // alias. Accept either a valid Resend/Svix signature or a matching
  // shared-secret header; require at least one to be set up.
  const haveSvix = Boolean(RESEND_INBOUND_SECRET);
  const haveShared = Boolean(INBOUND_WEBHOOK_SECRET);
  if (!haveSvix && !haveShared) {
    return serviceUnavailable("inbound-email:config", "no inbound auth secret configured");
  }
  const svixOk = haveSvix && (await verifySvix(req, rawBody, RESEND_INBOUND_SECRET));
  const sharedHeader = req.headers.get("x-aplyx-inbound-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const sharedOk = haveShared && Boolean(sharedHeader) && (await timingSafeEqual(sharedHeader, INBOUND_WEBHOOK_SECRET));
  if (!svixOk && !sharedOk) return unauthorized();

  let payload: InboundPayload | null;
  try {
    payload = JSON.parse(rawBody) as InboundPayload;
  } catch {
    payload = null;
  }
  if (payload === null || typeof payload !== "object") return badRequest("invalid webhook body");
  if (payload.type && payload.type !== "email.received") {
    return ok({ ignored: true });
  }

  const toAddress = extractFirstTo(payload.data?.to);
  const alias = localPart(toAddress);
  if (!alias) return ok({ ignored: true, reason: "missing to address" });

  const subject = String(payload.data?.subject ?? "").trim();
  const bodyText = String(payload.data?.text ?? payload.data?.html ?? "").trim();
  const fromAddress = String(payload.data?.from ?? "").trim();

  // Plain support mailbox: relay to a human and stop. Deliberately before
  // the managed_aliases path so support@ can never collide with an ATS
  // alias name, and so a support message never touches inbound_emails or
  // the OTP parser. A recipient on the apex (support@aplyx.app), not the
  // mail.aplyx.app subdomain the ATS aliases live on.
  if (domainPart(toAddress) === "aplyx.app" && SUPPORT_LOCALPARTS.has(alias)) {
    if (!SUPPORT_FORWARD_TO) {
      return serviceUnavailable("inbound-email:support-config", "SUPPORT_FORWARD_TO unset");
    }
    try {
      await forwardToInbox(SUPPORT_FORWARD_TO, fromAddress, subject, bodyText, toAddress);
    } catch (error) {
      return serverError("inbound-email:support-forward", error);
    }
    return ok({ forwarded: true });
  }
  const parsedOtp = extractOtp(`${subject}\n${bodyText}`);
  const parsedLink = extractLink(`${subject}\n${bodyText}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: aliasRow, error: aliasError } = await supabase
    .from("managed_aliases")
    .select("id, user_id, family, forwarding_to")
    .eq("alias", alias)
    .eq("status", "active")
    .maybeSingle();
  if (aliasError) {
    return serverError("inbound-email:alias-lookup", aliasError);
  }
  if (!aliasRow) {
    return ok({ ignored: true, reason: "unknown alias" });
  }

  const { data: pendingRun } = await supabase
    .from("apply_runs")
    .select("id")
    .eq("user_id", aliasRow.user_id)
    .eq("alias_id", aliasRow.id)
    .in("status", ["initialized", "package_assembled", "fill_planned", "filling", "ready_to_submit", "confirm_before_submit", "submitting"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const receivedAt = new Date().toISOString();
  // Verification secrets (OTP/link) get a short expiry, per the plan's
  // "expiring quickly if persistence is required," enforced by
  // list_own_inbound_emails (migration 0031), which redacts either
  // value once past expires_at. A plain reply with neither never
  // expires (there's nothing sensitive to age out).
  const expiresAt = parsedOtp || parsedLink ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;
  const { error: insertError } = await supabase.from("inbound_emails").insert({
    alias_id: aliasRow.id,
    apply_run_id: pendingRun?.id ?? null,
    from_address: fromAddress,
    subject,
    body_text: bodyText,
    parsed_otp: parsedOtp,
    parsed_link: parsedLink,
    received_at: receivedAt,
    expires_at: expiresAt,
  });
  if (insertError) {
    return serverError("inbound-email:insert", insertError);
  }

  try {
    await forwardEmail(String(aliasRow.forwarding_to ?? ""), subject, bodyText, toAddress);
    await supabase
      .from("inbound_emails")
      .update({ forwarded_at: new Date().toISOString() })
      .eq("alias_id", aliasRow.id)
      .eq("received_at", receivedAt)
      .eq("subject", subject)
      .eq("from_address", fromAddress);
  } catch (error) {
    console.error("inbound-email forward failed", error);
  }

  // Never echo the OTP/link in the response body: docs/ats-account-
  // credentials-plan.md: "Never print OTPs in logs or events," and a
  // webhook response is exactly the kind of thing that ends up in
  // Resend's delivery log and/or this function's own invocation logs.
  // The alias/run id stay out too — the sender already knows the alias,
  // and there's nothing for a webhook caller to do with either.
  return ok({ received: true });
});
