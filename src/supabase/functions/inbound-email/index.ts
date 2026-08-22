import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const INBOUND_WEBHOOK_SECRET = Deno.env.get("INBOUND_WEBHOOK_SECRET") ?? "";
const FORWARD_FROM = Deno.env.get("FORWARD_FROM") ?? "aplyx-mail@mail.aplyx.app";

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

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

function extractFirstTo(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

function localPart(address: string): string {
  return address.split("@")[0]?.trim().toLowerCase() ?? "";
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
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (INBOUND_WEBHOOK_SECRET) {
    const header = req.headers.get("x-aplyx-inbound-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (header !== INBOUND_WEBHOOK_SECRET) return unauthorized();
  }

  const payload = (await req.json()) as InboundPayload;
  if (payload.type && payload.type !== "email.received") {
    return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { "Content-Type": "application/json" } });
  }

  const toAddress = extractFirstTo(payload.data?.to);
  const alias = localPart(toAddress);
  if (!alias) return new Response(JSON.stringify({ ok: true, ignored: true, reason: "missing to address" }), { headers: { "Content-Type": "application/json" } });

  const subject = String(payload.data?.subject ?? "").trim();
  const bodyText = String(payload.data?.text ?? payload.data?.html ?? "").trim();
  const fromAddress = String(payload.data?.from ?? "").trim();
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
    return new Response(JSON.stringify({ ok: false, error: aliasError.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!aliasRow) {
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "unknown alias" }), { headers: { "Content-Type": "application/json" } });
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
  const { error: insertError } = await supabase.from("inbound_emails").insert({
    alias_id: aliasRow.id,
    apply_run_id: pendingRun?.id ?? null,
    from_address: fromAddress,
    subject,
    body_text: bodyText,
    parsed_otp: parsedOtp,
    parsed_link: parsedLink,
    received_at: receivedAt,
  });
  if (insertError) {
    return new Response(JSON.stringify({ ok: false, error: insertError.message }), { status: 500, headers: { "Content-Type": "application/json" } });
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

  return new Response(JSON.stringify({ ok: true, alias, apply_run_id: pendingRun?.id ?? null, parsed_otp: parsedOtp, parsed_link: parsedLink }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
