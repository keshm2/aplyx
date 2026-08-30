# Workday Personal Inbox Verification Plan

## Goal

Replace the managed-alias-only Workday verification boundary with a
personal-inbox workflow that uses the existing Google Gmail OAuth connection,
while retaining the managed-alias path as a supported compatibility path.
The workflow must support the common Workday account, email-link, OTP, MFA,
multi-step form, and final-confirmation paths without falsely reporting an
application as submitted.

“Any Workday tenant” means tenant-agnostic adapters and safe fallback for
unknown layouts. It does not mean bypassing CAPTCHA, SSO, security keys, or
unknown MFA challenges, and live tenant coverage must be documented honestly.

## Current Findings

- `src/supabase/functions/mail-oauth-start/` and `mail-oauth-callback/` already
  store read-only Gmail OAuth connections in `mail_connections`.
- `email-tracking-worker/index.ts` currently uses Gmail only for employer
  outcome tracking on already-applied jobs.
- Migrations `0016_verification_sessions.sql` and
  `0017_verification_messages.sql` define a hosted verification model, but no
  Gmail worker currently creates or resolves those sessions.
- `approve_submit_workday.py` still requires `--alias-email` and fills that
  value into account creation and login forms.
- `ReviewScreen.tsx` still claims a managed alias and reads `inbound_emails`
  instead of retrieving personal-inbox verification secrets.
- Local password sidecars are currently keyed by account identity plus tenant
  and protected with mode `0600`; checkpoints must remain secret-free.

## Implementation

1. Define a provider-neutral verification-session contract for Workday:
   candidate email, tenant, job/apply-run identity, challenge type, expected
   sender domains/subject tokens, status, expiry, attempts, and redacted
   message metadata. Never expose raw tokens in logs or durable checkpoints.
2. Add a hosted Gmail verification worker path that uses the existing OAuth
   refresh/token RPCs and Gmail read-only scope. It must search only within a
   short verification window, correlate by recipient/account, tenant/company,
   sender/domain, subject tokens, and job run, and reject ambiguous matches.
3. Store extracted OTP/link values as short-lived Vault secrets referenced by
   `verification_messages.secret_id`; expose them through an ownership-checked,
   two-step flow: `reveal_verification_secret` (pre-runtime, returns the raw
   value without consuming) and `consume_verification_secret` (post-runtime
   confirmation, redacts the message + deletes the Vault secret). Expired or
   consumed values are redacted and their Vault secrets deleted. A bounded
   cleanup function (`service_cleanup_expired_verification_secrets`) handles
   secrets whose retention window elapsed without consumption.
4. Create/update verification sessions when a Workday account is created or
   resumed. Poll with bounded backoff and a server-side attempt/expiry limit;
   never loop indefinitely. Support link and OTP challenges, repeated MFA
   steps, and explicit `manual_required` outcomes for TOTP, push, hardware-key,
   SSO, or tenant-specific challenges that cannot be safely automated.
   `create_verification_session` verifies that any `p_mail_connection_id`
   belongs to the caller before inserting.
5. Change the Workday runtime to accept an account email abstraction rather
   than requiring a managed alias. Preserve an optional alias input for
   existing runs, but allow a personal candidate email obtained from the
   authenticated profile/verification session. Key credentials by normalized
   account email plus tenant. Keep passwords out of checkpoints and logs.
6. Keep `--verification-link` and `--otp` as explicit continuation inputs, and
   add a secure session-secret input path that does not put raw values into
   command logs, environment snapshots, or persisted state. When a session
   secret file exists, omit raw `--verification-link`/`--otp` from argv
   entirely — the 0600 file is the sole secret handoff channel. Emit only
   hashes and boolean consumption flags.
7. Update the local/hosted bridge and Review screen to show the verification
   session, reveal a short-lived secret to a 0600 temp file, pass it to the
   runtime, and consume/redact it ONLY after the runtime confirms
   `used_verification_link`/`used_verification_otp`. Surface
   expiry/ambiguous/manual states. Do not require a managed alias when a
   connected personal inbox is ready. Correlation anchors sender-domain
   matching to actual email domains (not substring), requires an independent
   signal beyond recipient match, and handles display names, plus addressing,
   and Gmail dot normalization without matching another account.
8. Update the scheduled agent instructions and generated definitions so a
   connected Gmail workflow is attempted before checkpointing, while a missing
   inbox or unresolved challenge remains a truthful queue-only checkpoint.
9. Keep the final-submit safety contract unchanged: exact field verification,
   challenge detection, no blind final-submit retry, explicit confirmation
   required, and only `outcome == "submitted"` may write an applied result.

## Tests and Verification

- Add Python tests for personal-email account creation, credential reuse,
  session-secret handling, link/OTP continuation, repeated MFA/manual-required
  states, expiry, ambiguity, and no-submit behavior.
- Add TypeScript tests for bridge/UI session routing and applied-outcome guards.
- Add Deno/Supabase tests for Gmail message correlation, Vault secret expiry,
  ownership, one-time consumption, and no raw-token logging.
- Add migration/RLS tests for verification-session and message access.
- Run the complete existing Python, conformance, core build, app typecheck,
  generated-definition, config, and diff checks.
- Run a live no-submit test against Expedia plus at least one configured
  existing tenant when OAuth, browser, and test inbox access are available.
- Report unsupported tenant/MFA layouts as checkpoints; do not claim literal
  100% tenant coverage without live evidence.

## Completion Criteria

- Personal Gmail OAuth can supply a correlated Workday link/OTP without a
  managed alias.
- Managed aliases continue to work when configured.
- Account passwords are reused per email+tenant and never written to a
  checkpoint or log.
- Verification secrets are short-lived, ownership-checked, one-time, and
  redacted after use.
- Unknown MFA or tenant layouts stop safely and are resumable.
- No application is recorded as applied unless the runtime emits an explicit,
  unambiguous submitted outcome.
