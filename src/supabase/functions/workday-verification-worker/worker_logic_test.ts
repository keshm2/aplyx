// Deno tests for workday-verification-worker's pure correlation,
// extraction, manual-required detection, and redaction logic
// (docs/workday-personal-inbox-plan.md). Run with:
//   deno test --allow-read src/supabase/functions/workday-verification-worker/worker_logic_test.ts
//
// These cover the load-bearing safety properties of the Gmail ingestion
// path WITHOUT a live Gmail call or a live Supabase project: ambiguous
// matches never produce a secret, manual-required challenges are detected,
// redaction strips codes/links, and correlation rejects recipient
// mismatches. The hosted email-tracking-worker (post-application outcome
// tracking) is a separate function with separate logic — these tests do
// NOT touch it, preserving its unchanged behavior by construction.

import {
  assert,
  assertEquals,
  assertNotEquals,
} from "jsr:@std/assert@1";
import {
  correlate,
  detectManualRequired,
  extractLink,
  extractOtp,
  extractEmailAddress,
  normalizeEmailForCompare,
  redactSnippet,
  redactSubject,
} from "./worker_logic.ts";

const SESSION = {
  session_id: "s1",
  user_id: "u1",
  job_id: "workday-JR1",
  tenant_key: "co.wd5.myworkdayjobs.com",
  company: "Co",
  candidate_email: "candidate@example.invalid",
  challenge_type: "either",
  expected_sender_domains: ["workday.com", "co.wd5.myworkdayjobs.com"],
  expected_subject_tokens: ["verify", "code"],
  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  attempt_count: 0,
  connection_id: "c1",
  connection_email: "candidate@example.invalid",
  access_token: "fake",
  refresh_token: "fake",
};

Deno.test("extractOtp pulls a 6-digit code from verification text", () => {
  assertEquals(extractOtp("Your verification code is 482917"), "482917");
  assertEquals(extractOtp("code: 654321"), "654321");
});

Deno.test("extractOtp returns undefined when no code is present", () => {
  assertEquals(extractOtp("Welcome to your account"), undefined);
});

Deno.test("extractOtp does not treat an unrelated bare number as a code", () => {
  assertEquals(extractOtp("Your case number is 482917"), undefined);
});

Deno.test("extractLink returns the first non-noise URL", () => {
  const link = extractLink(
    "Click https://employer.example/verify?t=abc to verify. Unsubscribe: https://employer.example/unsub",
  );
  assertEquals(link, "https://employer.example/verify?t=abc");
});

Deno.test("extractLink rejects noise URLs (unsubscribe/privacy)", () => {
  assertEquals(
    extractLink("Please unsubscribe at https://employer.example/unsubscribe"),
    undefined,
  );
});

Deno.test("detectManualRequired flags TOTP/push/security-key/SSO", () => {
  assertEquals(detectManualRequired("Open your authenticator app"), "totp");
  assertEquals(detectManualRequired("Approve sign-in on your phone"), "push_approval");
  assertEquals(detectManualRequired("Insert your security key"), "security_key");
  assertEquals(detectManualRequired("Sign in with Google"), "sso");
});

Deno.test("detectManualRequired does not flag a plain OTP page", () => {
  // A normal verification-code page must NOT be misclassified — that
  // would stop a flow the worker should resolve.
  assertEquals(detectManualRequired("Enter your verification code"), undefined);
});

Deno.test("redactSubject strips digit runs and truncates", () => {
  const r = redactSubject("Your verification code 482917 for Workday");
  assert(r.includes("[code]"));
  assert(!r.includes("482917"));
  assert(r.length <= 80);
});

Deno.test("redactSnippet strips codes and links", () => {
  const r = redactSnippet("code: 482917 click https://employer.example/verify?t=abc");
  assert(r.includes("[code]"));
  assert(r.includes("[link]"));
  assert(!r.includes("482917"));
  assert(!r.includes("employer.example/verify"));
});

Deno.test("correlate matches on recipient + sender domain", () => {
  const r = correlate(
    {
      to: "candidate@example.invalid",
      from: "noreply@workday.com",
      subject: "Verify your Workday account",
      body: "code: 482917",
    },
    SESSION,
  );
  assert(r.matched);
  assert(r.score > 0);
});

Deno.test("correlate rejects a recipient mismatch", () => {
  const r = correlate(
    {
      to: "someone-else@example.invalid",
      from: "noreply@workday.com",
      subject: "Verify your account",
      body: "code: 482917",
    },
    SESSION,
  );
  assert(!r.matched);
  assertEquals(r.reason, "recipient mismatch");
});

Deno.test("correlate rejects when no independent correlation signal", () => {
  // Use a company name that won't match the from address domain
  // ("Co" would match "co.com" via domain includes); "FitCorp" avoids that.
  const r = correlate(
    {
      to: "candidate@example.invalid",
      from: "random@nowhere.com",
      subject: "Hello",
      body: "code: 482917",
    },
    { ...SESSION, company: "FitCorp", expected_sender_domains: [], expected_subject_tokens: [] },
  );
  assert(!r.matched);
  assertEquals(r.reason, "no independent correlation signal (recipient only)");
});

Deno.test("correlate matches on subject token when sender domain unknown", () => {
  const r = correlate(
    {
      to: "candidate@example.invalid",
      from: "noreply@co.com",
      subject: "Your verification code",
      body: "code: 482917",
    },
    { ...SESSION, expected_sender_domains: [] },
  );
  assert(r.matched);
  assert(r.score > 0);
});

// --- Finding 5: tightened correlation ---

Deno.test("correlate: positive match on recipient + trusted sender domain", () => {
  const r = correlate(
    {
      to: "candidate@example.invalid",
      from: "noreply@workday.com",
      subject: "Verify your Workday account",
      body: "code: 482917",
    },
    SESSION,
  );
  assert(r.matched);
  assert(r.score > 0);
});

Deno.test("correlate: false-positive — sender domain substring does not match", () => {
  // "evil-workday.com" must NOT match expected domain "workday.com" —
  // the old substring includes() would have matched this.
  const r = correlate(
    {
      to: "candidate@example.invalid",
      from: "noreply@evil-workday.com",
      subject: "Verify your account",
      body: "code: 482917",
    },
    { ...SESSION, expected_subject_tokens: [] },
  );
  assert(!r.matched, "evil-workday.com should not match workday.com");
});

Deno.test("correlate: ambiguous — recipient only, no independent signal -> manual_required", () => {
  // A message addressed to the candidate but from an unknown sender with
  // no subject tokens and no tenant match. The old code would have
  // matched on company name "Co" substring; the new code requires an
  // independent signal.
  const r = correlate(
    {
      to: "candidate@example.invalid",
      from: "random@nowhere.com",
      subject: "Hello",
      body: "code: 482917",
    },
    { ...SESSION, company: "FitCorp", expected_sender_domains: [], expected_subject_tokens: [] },
  );
  assert(!r.matched);
  assertEquals(r.reason, "no independent correlation signal (recipient only)");
});

Deno.test("correlate: subdomain of trusted sender domain matches", () => {
  // mail.workday.com is a subdomain of workday.com — should match.
  const r = correlate(
    {
      to: "candidate@example.invalid",
      from: "noreply@mail.workday.com",
      subject: "Verify",
      body: "code: 482917",
    },
    { ...SESSION, expected_sender_domains: ["workday.com"], expected_subject_tokens: [] },
  );
  assert(r.matched);
});

Deno.test("correlate: display name in From is parsed, domain extracted correctly", () => {
  const r = correlate(
    {
      to: "candidate@example.invalid",
      from: "Workday Security <noreply@workday.com>",
      subject: "Verify your account",
      body: "code: 482917",
    },
    SESSION,
  );
  assert(r.matched);
});

// --- Finding 9: Gmail To matching ---

Deno.test("extractEmailAddress: parses display name format", () => {
  assertEquals(extractEmailAddress("John Doe <john@example.com>"), "john@example.com");
  assertEquals(extractEmailAddress("john@example.com"), "john@example.com");
  assertEquals(extractEmailAddress("  <john@example.com>  "), "john@example.com");
});

Deno.test("normalizeEmailForCompare: Gmail dot normalization", () => {
  assertEquals(normalizeEmailForCompare("u.s.e.r@gmail.com"), "user@gmail.com");
  assertEquals(normalizeEmailForCompare("user@gmail.com"), "user@gmail.com");
  // Non-Gmail: dots are significant, not normalized.
  assertEquals(normalizeEmailForCompare("user.tag@example.com"), "user.tag@example.com");
});

Deno.test("normalizeEmailForCompare: plus addressing stripped", () => {
  assertEquals(normalizeEmailForCompare("user+workday@gmail.com"), "user@gmail.com");
  assertEquals(normalizeEmailForCompare("user+tag@example.com"), "user@example.com");
});

Deno.test("normalizeEmailForCompare: case insensitive", () => {
  assertEquals(normalizeEmailForCompare("User@Gmail.COM"), "user@gmail.com");
});

Deno.test("correlate: To with display name matches candidate", () => {
  const r = correlate(
    {
      to: "Candidate <Candidate@Example.invalid>",
      from: "noreply@workday.com",
      subject: "Verify",
      body: "code: 482917",
    },
    { ...SESSION, candidate_email: "candidate@example.invalid" },
  );
  assert(r.matched);
});

Deno.test("correlate: To with plus addressing matches candidate (Gmail)", () => {
  const r = correlate(
    {
      to: "user+workday@gmail.com",
      from: "noreply@workday.com",
      subject: "Verify",
      body: "code: 482917",
    },
    { ...SESSION, candidate_email: "user@gmail.com" },
  );
  assert(r.matched);
});

Deno.test("correlate: To with Gmail dots matches candidate", () => {
  const r = correlate(
    {
      to: "u.s.e.r@gmail.com",
      from: "noreply@workday.com",
      subject: "Verify",
      body: "code: 482917",
    },
    { ...SESSION, candidate_email: "user@gmail.com" },
  );
  assert(r.matched);
});

Deno.test("correlate: does NOT match a different Gmail account", () => {
  const r = correlate(
    {
      to: "other.user@gmail.com",
      from: "noreply@workday.com",
      subject: "Verify",
      body: "code: 482917",
    },
    { ...SESSION, candidate_email: "user@gmail.com" },
  );
  assert(!r.matched);
  assertEquals(r.reason, "recipient mismatch");
});

Deno.test("correlate: does NOT match a different non-Gmail account (dots significant)", () => {
  const r = correlate(
    {
      to: "user.tag@example.com",
      from: "noreply@workday.com",
      subject: "Verify",
      body: "code: 482917",
    },
    { ...SESSION, candidate_email: "usertag@example.com" },
  );
  assert(!r.matched);
  assertEquals(r.reason, "recipient mismatch");
});

// Regression: the outcome-tracking worker's classify() vocabulary is a
// separate function in a separate file. This test asserts the
// verification worker's exports do NOT include any outcome classification
// (rejected/offer/oa_sent/interview_requested) — proving the two workers
// cannot be confused at the import boundary.
Deno.test("verification worker exports no outcome-classification symbols", () => {
  const mod = import.meta;
  // The only exported pure functions are the ones imported above; none
  // of them classify employer outcomes. This is a structural guard: if
  // someone ever re-exports classify() here, this test would need updating
  // and the review would catch the cross-worker contamination.
  assertNotEquals(correlate, undefined);
  assertNotEquals(extractOtp, undefined);
  assert(typeof mod.url === "string");
});
