// Pure logic for workday-verification-worker: correlation, extraction,
// manual-required detection, and redaction. Extracted from index.ts so
// Deno tests can import these without triggering the top-level
// Deno.serve() in index.ts (which binds a port on import). index.ts
// imports these via `from "./worker_logic.ts"`. No network, no Supabase,
// no env: safe to unit-test in isolation.

export interface ActiveSession {
  session_id: string;
  user_id: string;
  job_id: string;
  tenant_key: string | null;
  company: string | null;
  candidate_email: string;
  challenge_type: string;
  expected_sender_domains: string[];
  expected_subject_tokens: string[];
  expires_at: string | null;
  attempt_count: number;
  connection_id: string;
  connection_email: string;
  access_token: string;
  refresh_token: string;
}

// Deterministic OTP/link extraction: same spirit as inbound-email's
// extractOtp/extractLink, never an LLM call. Workday verification codes
// are 4-8 digits; verification links are the first non-noise URL.
export function extractOtp(text: string): string | undefined {
  const match = text.match(/\b(?:code|otp|verification code|one-time passcode)\D{0,20}(\d{4,8})\b/i);
  return match?.[1];
}

export function extractLink(text: string): string | undefined {
  const urls = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const NOISE = /unsubscribe|opt-?out|preferences|privacy-?policy|tracking\.|\/pixel|mail\.aplyx\.app/i;
  return urls.find((u) => !NOISE.test(u));
}

// Challenges that can NEVER be safely automated: record as manual_required,
// never guess. Detected from subject/body text only (no DOM access here).
const MANUAL_REQUIRED_PATTERNS: [string, RegExp][] = [
  ["totp", /\bauthenticator(?: app)?\b/i],
  ["push_approval", /\b(?:approve|deny)\s+(?:sign[\s-]?in|login|request)\b/i],
  ["push_approval", /\bpush\s+notification\b/i],
  ["security_key", /\bsecurity\s+key\b/i],
  ["hardware_key", /\byubikey\b/i],
  ["sso", /\bsingle\s+sign[\s-]?on\b/i],
  ["sso", /\bsign\s+in\s+with\s+(?:google|microsoft|okta|sso)\b/i],
  ["unsupported_mfa", /\bmulti[\s-]?factor\b/i],
];

export function detectManualRequired(text: string): string | undefined {
  for (const [label, re] of MANUAL_REQUIRED_PATTERNS) {
    if (re.test(text)) return label;
  }
  return undefined;
}

export function redactSubject(subject: string): string {
  // Keep enough to audit correlation without retaining the full subject
  // (which can echo the OTP). Trim to 80 chars and strip digit runs.
  return subject.replace(/\d{4,8}/g, "[code]").slice(0, 80);
}

export function redactSnippet(text: string): string {
  return text.replace(/\d{4,8}/g, "[code]").replace(/https?:\/\/[^\s]+/gi, "[link]").slice(0, 160);
}

// Correlation: a message is a candidate match only when its recipient
// matches the session's candidate_email (with display-name parsing, case
// insensitivity, plus-addressing, and Gmail dot normalization) AND there
// is a sufficient independent correlation signal: a trusted sender
// domain match (anchored to the actual email domain, not a substring) OR
// a strong tenant/subject token match. Heuristic company-domain guesses
// are NOT used; only the actual sender domain extracted from the From
// address is compared against expected_sender_domains. Ambiguous or
// low-confidence matches become manual_required, never a guess.

/** Extracts the bare email address from a To/From header value, handling
 *  display names ("John Doe <john@example.com>"), bare addresses, and
 *  surrounding whitespace/angle brackets. Returns the lowercased email
 *  or the trimmed lowercased input if no angle-bracket form is found. */
export function extractEmailAddress(header: string): string {
  const match = header.match(/<([^>]+)>/);
  return (match ? match[1] : header).trim().toLowerCase();
}

/** Normalizes a Gmail/GoogleMail address for comparison: strips dots from
 *  the local part and strips plus-addressing tags. For non-Gmail domains,
 *  only plus-addressing is stripped (dot normalization is Gmail-specific
 *  and would incorrectly match different accounts on other providers). */
export function normalizeEmailForCompare(email: string): string {
  const lower = email.trim().toLowerCase();
  const atIdx = lower.lastIndexOf("@");
  if (atIdx < 0) return lower;
  let local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);
  // Strip plus-addressing tag (applies to all providers).
  const plusIdx = local.indexOf("+");
  if (plusIdx >= 0) local = local.slice(0, plusIdx);
  // Gmail dot normalization: dots in the local part are ignored by
  // Gmail. Only apply to gmail/googlemail: other providers treat dots
  // as significant (user.tag@example.com != usertag@example.com).
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

/** Extracts the domain from an email address (the part after @). */
export function extractDomain(email: string): string {
  const atIdx = email.lastIndexOf("@");
  return atIdx >= 0 ? email.slice(atIdx + 1) : "";
}

/** Returns true if `domain` equals or is a subdomain of `expected`.
 *  Anchored: "evil.com" does NOT match "workday.com" or "co.com". */
function domainMatches(domain: string, expected: string): boolean {
  if (!domain || !expected) return false;
  return domain === expected || domain.endsWith("." + expected);
}

export function correlate(
  msg: { to: string; from: string; subject: string; body: string },
  session: ActiveSession,
): { matched: boolean; score: number; reason: string } {
  // Recipient matching: parse display names, normalize case, plus
  // addressing, and Gmail dot normalization. Must NOT match another
  // account: the normalized forms must be exactly equal.
  const toEmail = extractEmailAddress(msg.to);
  const candidateNorm = normalizeEmailForCompare(session.candidate_email.toLowerCase());
  const toNorm = normalizeEmailForCompare(toEmail);
  if (toNorm !== candidateNorm) {
    return { matched: false, score: 0, reason: "recipient mismatch" };
  }

  const fromEmail = extractEmailAddress(msg.from);
  const fromDomain = extractDomain(fromEmail);
  const subjectLower = msg.subject.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  // Sender domain: anchored match against the actual From domain, not a
  // substring of the From header. "noreply@evil-workday.com" must NOT
  // match expected domain "workday.com".
  let senderMatched = false;
  for (const domain of session.expected_sender_domains ?? []) {
    if (domainMatches(fromDomain, domain.toLowerCase())) {
      score += 0.5;
      reasons.push(`sender:${domain}`);
      senderMatched = true;
    }
  }

  // Subject tokens: still substring-based (subject text is free-form),
  // but only counts as a signal when combined with a recipient match
  // (already verified above).
  let subjectMatched = false;
  for (const token of session.expected_subject_tokens ?? []) {
    if (subjectLower.includes(token.toLowerCase())) {
      score += 0.3;
      reasons.push(`subject:${token}`);
      subjectMatched = true;
    }
  }

  // Tenant key: anchored domain match against the From domain, or a
  // substring of the subject (tenant keys are hostnames, not free text).
  let tenantMatched = false;
  if (session.tenant_key) {
    const tenant = session.tenant_key.toLowerCase();
    if (domainMatches(fromDomain, tenant) || subjectLower.includes(tenant)) {
      score += 0.2;
      reasons.push(`tenant:${session.tenant_key}`);
      tenantMatched = true;
    }
  }

  // Company name: only as a weak secondary signal via the From domain or
  // subject: never as a heuristic domain guess. A company name like "Co"
  // substring-matching "nowhere.com" was a false-positive source; now we
  // only check if the company name appears in the From domain or subject.
  if (session.company) {
    const name = session.company.toLowerCase();
    if (fromDomain.includes(name) || subjectLower.includes(name)) {
      score += 0.1;
      reasons.push(`company:${session.company}`);
    }
  }

  // Require a sufficient independent correlation signal: the recipient
  // match alone is necessary but not sufficient. At least one of (trusted
  // sender domain, strong subject token, tenant match) must be present.
  // Without that, a message merely addressed to the candidate with a
  // code-like number in the body could be any sender: route to
  // manual_required rather than guessing.
  if (!senderMatched && !subjectMatched && !tenantMatched) {
    return { matched: false, score: 0, reason: "no independent correlation signal (recipient only)" };
  }

  return { matched: true, score, reason: reasons.join(",") };
}

// MIME plain-text extraction: walks a Gmail message payload tree looking
// for the first text/plain part (falls back to tag-stripped text/html).
// Kept here so the test suite can exercise it without a live Gmail call.
interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function extractPlainText(payload: GmailPart | undefined): string {
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
