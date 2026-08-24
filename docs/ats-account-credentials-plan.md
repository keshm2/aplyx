# ATS Account Credentials and Status Access Plan

## Purpose

This plan adds a secure account-credential layer to aplyx for ATS systems that require an account. When aplyx creates an account using the user's email or a managed alias, it should retain the generated credential securely so the account can be reused for document upload, user-requested login, and optional employer-status tracking.

Account creation, application preparation, and final application submission remain separate operations. Creating an account or uploading a resume must never silently submit an application.

The plan applies across all supported ATS families and tenants. An ATS family is not sufficient as an account key because two companies using the same ATS may have separate tenants and separate candidate accounts.

## Existing Architecture

The implementation should extend, rather than bypass, these existing surfaces:

| Existing component | Role in this plan |
| --- | --- |
| `managed_aliases` | Per-user aliases used by account-required application flows |
| `apply_runs` | Durable application workflow state and account linkage |
| `inbound_emails` | Verification and employer-email intake for managed aliases |
| Supabase Vault | Server-side secret storage already used for sensitive hosted credentials |
| `atsRegistry.ts` | ATS family capability and account-model decisions |
| `applicantPackage.ts` | Applicant identity and email selection |
| `approve_submit_*.py` | Browser account, form, and checkpoint runtimes |
| `src/worker/` | Hosted scheduled processing and status tracking |
| `state.ts` and `SupabaseAdapter` | Application and outcome state access |

Proposed tables, RPCs, workers, UI, and adapters are identified as new in the sections below.

## Security Model

### Non-negotiable rules

- Only the owning authenticated user may view their ATS account metadata.
- Only the owning authenticated user may request their own ATS username or password.
- No user may read, reveal, use, update, or delete another user's ATS records or credentials.
- Database row-level security must enforce ownership; UI filtering is not sufficient.
- Decrypted passwords must never be returned by ordinary client-readable table queries.
- Passwords must never appear in plaintext in database columns, JSON state, logs, screenshots, browser traces, prompts, crash reports, analytics, or Discord notifications.
- Service-role access must be limited to narrowly scoped server-side operations and must still validate the target user's ownership.
- An ATS password may be revealed only after an explicit user action, preferably with recent re-authentication.
- A status worker may use a credential just in time, but must not expose the credential to the browser frontend or persist a browser session.
- Account creation and resume upload never imply approval to submit the final application.

### Threat assumptions

The design must assume that:

- A client can be modified or replayed by a malicious user.
- A user may attempt to alter `user_id` or `account_id` request parameters.
- Logs and browser artifacts may be copied or uploaded accidentally.
- A worker credential could be exposed if it is printed, serialized, or included in an exception.
- Multiple users may share an ATS family but must remain completely isolated.
- A compromised account must be revocable without deleting unrelated user data.

## Proposed Data Model

### `application_accounts` table

This new table stores metadata and references only. It must not store the username or password in plaintext.

```text
id uuid primary key
user_id uuid not null references auth.users(id)
ats_family text not null
tenant_key text not null
company_name text not null
login_hint text null
credential_secret_id uuid not null
managed_alias_id uuid null references managed_aliases(id)
status text not null
verification_status text not null
status_tracking_enabled boolean not null default false
created_at timestamptz not null
updated_at timestamptz not null
last_login_at timestamptz null
last_verified_at timestamptz null
last_status_check_at timestamptz null
last_error_code text null
last_error_message text null
deleted_at timestamptz null
```

Recommended states:

```text
creation_pending
created_unverified
verification_pending
active
login_failed
locked
reset_required
disabled
deleted
```

`tenant_key` should be a normalized ATS tenant identifier, such as a host, site, company slug, or provider-specific account scope. It must not rely on display names.

Add a unique constraint on the active identity:

```text
(user_id, ats_family, tenant_key, login_hint_hash)
```

The actual login identifier may be kept inside Vault. If a lookup hint is required, store only a keyed HMAC or another non-reversible comparison value plus a masked display value.

### `application_account_links` table

This new table links applications to the account used for that ATS tenant.

```text
id uuid primary key
user_id uuid not null references auth.users(id)
account_id uuid not null references application_accounts(id)
applied_job_id uuid null
job_key text not null
created_at timestamptz not null
```

The link must include `user_id` and enforce that the account and application belong to the same user.

### `application_account_events` table

This new append-only audit table records lifecycle events without secret values.

```text
id uuid primary key
user_id uuid not null references auth.users(id)
account_id uuid not null references application_accounts(id)
event_type text not null
metadata jsonb not null default '{}'
created_at timestamptz not null
```

Permitted event types include `creation_started`, `account_created`, `verification_requested`, `verification_succeeded`, `login_succeeded`, `login_failed`, `password_rotated`, `status_check_succeeded`, `status_check_failed`, `disabled`, and `deleted`.

Metadata must be redacted before insertion. It may contain a tenant key, status code, attempt number, or sanitized error category, but never credentials, OTPs, cookies, or raw page content.

### Vault secret format

Store the credential as one Vault secret so the username and password have the same lifecycle:

```json
{
  "username": "...",
  "password": "..."
}
```

The database stores only the Vault secret identifier. The secret name should include a random opaque account ID, not the user's email or company name.

## Vault and Authorization Boundaries

Add new server-side RPCs or Edge Function operations:

- `create_application_account`: creates a Vault secret and metadata row for `auth.uid()`.
- `get_application_account_metadata`: returns only the caller's non-secret metadata.
- `issue_account_credential_use_token`: creates a short-lived, single-purpose token for a worker operation.
- `reveal_own_account_credential`: requires explicit user action and recent re-authentication.
- `rotate_application_account_secret`: replaces the Vault secret after a reset or password change.
- `mark_account_state`: updates only an owned account and validates allowed transitions.
- `delete_application_account`: revokes the Vault secret and soft-deletes metadata.

The normal frontend must never call Vault directly. A server-side worker may resolve a secret only after checking:

1. The authenticated or internally authorized user identity.
2. The account belongs to that user.
3. The account is in a permitted state.
4. The operation has a valid purpose and unexpired request token.
5. The target application or status-check job belongs to that user.

Use security-definer functions only with explicit ownership checks and fixed `search_path` settings. Do not expose a generic “read secret by ID” RPC.

## Row-Level Security

Enable and test RLS on every proposed table.

Required policy properties:

- `application_accounts`: `select`, `update`, and delete requests require `user_id = auth.uid()`.
- `application_account_links`: access requires both the link's `user_id` and its referenced account's `user_id` to equal `auth.uid()`.
- `application_account_events`: users may read only their own events; inserts happen through controlled server functions.
- Vault secret IDs are never sufficient authorization by themselves.
- A user cannot infer another user's record through counts, error messages, unique-constraint responses, or tenant searches.
- Service-role worker paths must perform an explicit ownership join before use.

Add automated cross-user tests that attempt every read, update, delete, reveal, reset, and status-check operation using another user's IDs. Every attempt must return a generic not-found or unauthorized result without leaking whether the record exists.

## Account Creation Lifecycle

1. Resolve the ATS family and normalized tenant key.
2. Determine whether the flow uses the user's real email or an owned managed alias.
3. Find an existing account only within the current user's tenant scope.
4. Reuse an active account instead of creating a duplicate.
5. For a missing account, generate a high-entropy password in memory.
6. Create the Vault secret and `creation_pending` metadata row before account-form submission.
7. Link the current `apply_run` to the account ID.
8. Submit only the account-creation form.
9. Confirm account acceptance using a positive, ATS-specific signal.
10. Mark the account `created_unverified` or `verification_pending`.
11. Match the verification email or OTP to the exact user, alias, account, and tenant.
12. On successful verification, mark the account `active`.
13. If creation fails, revoke the unused Vault secret and mark the attempt failed.
14. If the result is ambiguous, preserve the checkpoint but do not retry account creation blindly.

Account creation retries must be idempotent. A retry must first check for an existing account or pending account before generating another password.

## Verification and Inbox Handling

Verification state should be short-lived and associated with:

```text
user_id
account_id
managed_alias_id
ats_family
tenant_key
requested_at
expires_at
```

Do not match verification messages by company name alone. A message is eligible only when its recipient, alias, tenant URL, or account correlation data matches the pending account.

OTP requirements:

- Store no OTP after successful use.
- Keep pending OTP state encrypted and expiring quickly if persistence is required.
- Never print OTPs in logs or events.
- Reject expired, reused, or ambiguous codes.
- Limit verification attempts and apply backoff.
- Record only a sanitized success or failure event.
- Require explicit user action when a message cannot be confidently matched.

## Browser Runtime Resilience

Browser automation must treat page loading as asynchronous and stateful. Fixed sleeps alone are not sufficient.

### Navigation and readiness

- Use `domcontentloaded` as the first navigation milestone.
- Wait for the page-specific root or heading to be visible before querying controls.
- Allow a 500–1500 ms settling delay after the root becomes visible for client-rendered controls.
- Use `networkidle` only as an optional bounded hint; do not wait indefinitely for pages with analytics or streaming requests.
- Use a 20–30 second navigation timeout and a 8–12 second element timeout by default.
- Reacquire locators after navigation or React/Workday rerenders; never reuse stale element handles.

### Control interaction

- Require the control to be visible, enabled, and attached immediately before clicking.
- After each click, wait for one of: URL change, expected page signature, expected heading, modal visibility, or a known loading state to disappear.
- Use a 1–3 second post-click settle window before declaring a transition failed.
- If a control is temporarily unavailable, retry at most three times with delays of approximately 500 ms, 1.5 s, and 4 s.
- Re-query after a stale-element error rather than retrying the same handle.
- Detect and checkpoint on overlays, CAPTCHA, bot checks, unexpected login pages, or verification gates.

### Retry policy

- Apply bounded exponential backoff with jitter.
- Never retry a final submit automatically.
- Never retry account creation when the result is ambiguous.
- Retry navigation or non-mutating reads only when the page signature confirms the same safe step.
- Record an attempt number and sanitized failure category.
- Stop after a total step budget to prevent loops.

### State and checkpoints

Every checkpoint must include the page signature, normalized URL, current step, account ID, and safe progress metadata. It must not include a password, OTP, cookie, or raw page dump.

The runtime should detect repeated signatures and return a human-review checkpoint. A repeated signature must not cause a blind click or duplicate account creation.

## Resume Tailoring and Upload

Resume tailoring is a document-generation step, not an opportunity to change the job description or invent applicant facts.

The tailoring flow should:

1. Load the user's master resume.
2. Load the canonical ATS job description.
3. Extract relevant skills and requirements.
4. Reorder or rewrite only truthful resume content.
5. Preserve dates, employers, degrees, metrics, and certifications.
6. Report the selected resume variant, ATS score, and missing keywords.
7. Render a separate PDF artifact.
8. Store the artifact reference on the apply run.
9. Upload only after the user-approved application flow reaches the resume step.

The original master resume must not be overwritten automatically. If tailoring fails or times out, use the existing approved resume and record that no tailored artifact was produced.

After upload:

- Verify the ATS reports the file as attached or displays its filename.
- Wait for upload completion and any parsing indicator to settle.
- Never infer success solely from a click returning.
- Continue only through non-submit steps requested by the user.
- Stop before review or final submission unless the user explicitly approves that separate action.

## Credential Retrieval for User Actions

The account screen should show masked metadata only:

```text
Company
ATS family
Tenant
Masked username
Account status
Verification status
Last login
Last status check
```

Supported explicit actions:

- Open ATS login with an ephemeral credential-filled browser session.
- Reveal the user's own username and password after recent re-authentication.
- Copy the user's own password once, with an audit event.
- Test login without submitting an application.
- Request password reset.
- Disable status tracking.
- Delete the stored credential.

The frontend must never receive another user's credential, even if a user modifies an account ID in the request. The server must authorize every operation independently.

## Status Tracking

Status tracking is optional, user-controlled, and best effort.

The worker should:

1. Load an owned account and linked applications.
2. Obtain a short-lived credential-use token.
3. Resolve the Vault secret server-side.
4. Launch an ephemeral browser context.
5. Log in using an ATS-specific adapter.
6. Read application status from the appropriate dashboard or endpoint.
7. Store status, evidence URL, timestamp, and sanitized source details.
8. Close the context and discard credentials and session data.

Do not store cookies, browser profiles, refresh tokens, or dashboard HTML. Apply per-user and per-ATS rate limits, respect robots/terms constraints, and provide a disable switch.

Maintain separate fields for:

```text
aplyx_submission_status: applied | failed | needs_review
employer_outcome_status: applied | oa_sent | interview_requested | offer | rejected | withdrawn
```

Employer status is a signal for user review, not an authoritative decision that changes application state automatically.

## Password Reset and Rotation

When login fails:

1. Mark the account `login_failed`.
2. Stop automatic retries.
3. Record a sanitized failure event.
4. Notify the user.
5. Offer an explicit reset flow.

A reset flow must:

- Create a short-lived reset request linked to the owned account.
- Send or wait for the ATS reset email.
- Never use an old reset link automatically.
- Generate a new password only after reset completion.
- Replace the Vault secret atomically.
- Revoke or invalidate the old secret.
- Mark the account `active` only after a successful login or equivalent confirmation.

Password reset must not silently happen because a status check failed.

## Local Install Strategy

Hosted accounts use Supabase Vault. Local installs must use the operating system credential manager:

- macOS Keychain
- Windows Credential Manager
- Linux Secret Service

Local checkpoints may contain an opaque credential key but never the credential. If an OS credential store is unavailable, the flow must stop with `needs_review`; plaintext JSON is not an allowed fallback.

## Proposed Migration Sequence

1. Add `application_accounts`, `application_account_links`, and `application_account_events`.
2. Add strict RLS and ownership constraints.
3. Add Vault creation, retrieval-token, rotation, and deletion functions.
4. Add `account_id` references to hosted `apply_runs`.
5. Refactor browser checkpoints to remove password persistence.
6. Add account lifecycle and verification event handling.
7. Add ATS registry account-identity and tenant-key support.
8. Add user account-management UI.
9. Add just-in-time status-tracking credential access.
10. Add local OS-keychain support.
11. Enable on a controlled test account.
12. Run security, browser, and recovery tests before broader rollout.

## Work Packages and Acceptance Criteria

### Package 1: Data model and RLS

Acceptance criteria:

- All new tables have RLS enabled.
- Every policy scopes through `auth.uid()`.
- Cross-user reads, updates, deletes, reveals, and status checks fail without record-existence leakage.
- Account and application links cannot cross users.

### Package 2: Vault service

Acceptance criteria:

- Credentials are stored only in Vault.
- No client query returns decrypted credentials by default.
- Secret creation and metadata creation are coordinated and recoverable.
- Deletion removes the Vault secret.
- Rotation invalidates the previous secret.

### Package 3: Apply-run integration

Acceptance criteria:

- Account-required ATS flows create or reuse an owned account.
- Apply runs store `account_id`, never a password.
- Duplicate account creation is prevented.
- Account creation and final submission are separate state transitions.

### Package 4: Browser resilience

Acceptance criteria:

- Browser steps wait for visibility, enabled state, and page readiness.
- Delayed retries use bounded exponential backoff.
- Stale elements are reacquired.
- Repeated page signatures create checkpoints instead of loops.
- CAPTCHA, verification, timeouts, and ambiguous transitions fail closed.
- Final submission is never automatically retried.

### Package 5: Verification and recovery

Acceptance criteria:

- Verification messages are matched to the exact user/account/tenant.
- OTPs expire and are never logged.
- Failed login stops retries and offers explicit recovery.
- Password rotation and deletion are auditable.

### Package 6: User account center

Acceptance criteria:

- Users see only their own account metadata.
- Credentials are masked by default.
- Reveal and copy require explicit action and recent authentication.
- User-requested login does not expose credentials to unrelated clients.

### Package 7: Status adapters

Acceptance criteria:

- Credentials are fetched just in time and discarded after use.
- Browser contexts are ephemeral.
- No cookies or session tokens persist.
- Status results link only to owned applications.
- Rate limits, opt-in state, and sanitized evidence are enforced.

## Required Tests

- Cross-user RLS denial tests for every table and RPC.
- Secret scanning of source, logs, checkpoints, screenshots, and generated artifacts.
- Tests proving passwords never enter checkpoint JSON or subprocess output.
- Vault create, retrieve-token, rotate, revoke, and delete tests.
- Duplicate-account and tenant-isolation tests.
- Failed account-creation cleanup tests.
- OTP matching, expiry, replay, and wrong-user rejection tests.
- Password reset and login-failure tests.
- Browser readiness, delayed-render, stale-element, timeout, retry, and repeated-signature tests.
- CAPTCHA and ambiguous-outcome tests.
- Resume upload verification tests.
- Tests proving account creation and document upload cannot invoke final submission.
- Status-worker tests proving credentials and browser sessions are not persisted.
- User deletion tests proving all owned secrets and metadata are removed.

## Observability and Retention

Log only:

- Opaque account ID
- ATS family and normalized tenant key
- Lifecycle state
- Attempt number
- Sanitized error category
- Timing and latency metrics
- Status-check result category

Never log usernames, passwords, OTPs, cookies, authorization headers, full form payloads, or raw email bodies.

Define retention periods for account events, verification state, status evidence, and failed checkpoints. Deleting an account must revoke the secret immediately and remove or anonymize associated metadata according to the user's deletion request.

## Rollout Gates

Do not enable production credential storage until:

1. RLS cross-user tests pass.
2. Secret-leak scans pass.
3. Vault deletion and rotation are verified.
4. Browser checkpoints contain no secrets.
5. Account creation can be resumed without duplicate accounts.
6. User-only reveal and login paths are tested.
7. Status tracking is opt-in and rate-limited.
8. Account creation, resume upload, and final submission have independent guards.
9. The implementation has a documented incident-response and credential-rotation procedure.

## Decisions to Confirm Before Implementation

- Whether hosted credential storage is enabled for all users or only an opt-in tier.
- Whether user credential reveal requires re-authentication for every reveal or only after a short session window.
- Which ATS families support dashboard status checks in the first release.
- Whether managed aliases are mandatory for account-required ATS families.
- Exact Vault retention and deletion timing.
- Local OS-keychain support priority.
- Maximum browser retry and status-polling budgets.
- Whether user-requested login should fill credentials automatically or provide a one-time reveal.

Safe default: enable account storage only for explicit opt-in users, keep credentials server-side, require user ownership checks on every operation, use ephemeral browser sessions, and fail closed whenever identity, page state, or submission outcome is ambiguous.
