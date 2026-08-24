-- ATS account-credential layer — Package 1 (data model + RLS) of
-- docs/ats-account-credentials-plan.md. Scoped deliberately: this
-- migration adds the three tables, their RLS, and ownership-enforcing
-- constraints. It does NOT add Vault secret creation/rotation/reveal
-- RPCs (Package 2), apply_runs.account_id wiring (Package 3), or any
-- UI — those are separate follow-up packages per the plan's own
-- "one phase at a time" sequencing, confirmed with the operator
-- 2026-08-22 (scope: Package 1 only, stop and report before Package 2).
--
-- Two places this migration deviates from the plan document's literal
-- column list, both because the plan's schema didn't match tables that
-- already exist in this project:
--
-- 1. application_account_links.applied_job_id is `text`, not `uuid`, and
--    is a composite FK (user_id, applied_job_id) -> applied_jobs
--    (user_id, job_id) — applied_jobs (migration 0001) has no surrogate
--    uuid id at all; its primary key is the composite (user_id, job_id)
--    where job_id is text. A bare `uuid` column as the plan specified
--    would reference nothing.
-- 2. The plan's top-level column list for application_accounts has only
--    `login_hint text null`, but the "Vault secret format" section later
--    requires the *unique constraint* to key on `login_hint_hash`, and
--    separately says a lookup hint must be "a keyed HMAC ... plus a
--    masked display value" — two distinct values, not one. This adds
--    `login_hint_hash text null` alongside `login_hint` (the masked
--    display value) to satisfy both requirements the plan actually
--    states. Computing the HMAC itself is a Package 2 concern (needs a
--    server-only keying secret inside a SECURITY DEFINER function) —
--    this migration only adds the column.

-- --- application_accounts -----------------------------------------------

create table if not exists public.application_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  ats_family text not null,
  tenant_key text not null,
  company_name text not null,
  -- Masked display value only ("j***@company.com"), never the real
  -- login identifier — that lives in Vault (credential_secret_id) per
  -- the plan's Security Model.
  login_hint text,
  -- Keyed HMAC of the real login identifier, computed server-side by a
  -- future Package 2 RPC — never the plaintext identifier itself. Used
  -- for the duplicate-account lookup the unique constraint below covers
  -- and for "find an existing account within tenant scope" without ever
  -- reversing or storing the real value outside Vault.
  login_hint_hash text,
  -- Points at a Vault secret holding {"username":...,"password":...} as
  -- one JSON payload (see plan's "Vault secret format") — created only
  -- by a Package 2 RPC, never directly by a client. No "on delete"
  -- clause on purpose: a metadata row must never end up pointing at a
  -- vault.secrets row that no longer exists, so deleting the secret
  -- while a row still references it is refused rather than silently
  -- nulling a NOT NULL column. Package 2's delete/revoke path is
  -- expected to overwrite the secret's value (vault.update_secret),
  -- not delete the vault.secrets row.
  credential_secret_id uuid not null references vault.secrets (id),
  managed_alias_id uuid references public.managed_aliases (id) on delete set null,
  status text not null default 'creation_pending'
    check (status in (
      'creation_pending', 'created_unverified', 'verification_pending', 'active',
      'login_failed', 'locked', 'reset_required', 'disabled', 'deleted'
    )),
  -- Not given an explicit enum by the plan (unlike `status`, which has a
  -- "Recommended states" list) — inferred from the verification lifecycle
  -- narrated in "Account Creation Lifecycle" / "Verification and Inbox
  -- Handling". Revisit in Package 2 if the actual verification RPC needs
  -- a different vocabulary.
  verification_status text not null default 'not_started'
    check (verification_status in ('not_started', 'pending', 'verified', 'failed')),
  status_tracking_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz,
  last_verified_at timestamptz,
  last_status_check_at timestamptz,
  last_error_code text,
  last_error_message text,
  deleted_at timestamptz
);

-- NULLs don't collide under a standard unique constraint (Postgres
-- treats each NULL as distinct), so this only actually prevents a
-- duplicate once login_hint_hash is populated — a row created before
-- the real identifier is known (see plan's Account Creation Lifecycle
-- step 6, "before account-form submission") can't be deduplicated by
-- this constraint alone. Package 2's create_application_account RPC is
-- expected to also explicitly check for an existing pending/active
-- account in scope before inserting (plan's lifecycle steps 3-4),
-- exactly like it says to.
create unique index if not exists application_accounts_identity_uq
  on public.application_accounts (user_id, ats_family, tenant_key, login_hint_hash);

create index if not exists application_accounts_user_idx
  on public.application_accounts (user_id);

create trigger application_accounts_set_updated_at
  before update on public.application_accounts
  for each row execute function public.set_updated_at();

alter table public.application_accounts enable row level security;

create policy "application_accounts_select_own" on public.application_accounts
  for select using (auth.uid() = user_id);
create policy "application_accounts_insert_own" on public.application_accounts
  for insert with check (auth.uid() = user_id);
create policy "application_accounts_update_own" on public.application_accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "application_accounts_delete_own" on public.application_accounts
  for delete using (auth.uid() = user_id);

-- --- application_account_links -------------------------------------------

create table if not exists public.application_account_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references public.application_accounts (id) on delete cascade,
  -- text, not uuid — see the file header. Nullable: a link can exist
  -- before the application itself has landed in applied_jobs yet.
  applied_job_id text,
  job_key text not null,
  created_at timestamptz not null default now(),
  -- Composite FKs, not a bare column check — this is what actually
  -- enforces "the account and application belong to the same user" at
  -- the database layer (plan's own wording) rather than relying on
  -- application code to remember to check both.
  foreign key (user_id, applied_job_id) references public.applied_jobs (user_id, job_id) on delete set null,
  foreign key (user_id, job_key) references public.jobs (user_id, job_key) on delete cascade
);

create index if not exists application_account_links_user_idx
  on public.application_account_links (user_id);
create index if not exists application_account_links_account_idx
  on public.application_account_links (account_id);

alter table public.application_account_links enable row level security;

-- Every policy re-checks account ownership via EXISTS, not just the
-- link's own user_id column — belt-and-suspenders per the plan's
-- explicit requirement that access "requires both the link's user_id
-- and its referenced account's user_id to equal auth.uid()", not just
-- one or the other.
create policy "application_account_links_select_own" on public.application_account_links
  for select using (
    auth.uid() = user_id
    and exists (
      select 1 from public.application_accounts a
      where a.id = application_account_links.account_id and a.user_id = auth.uid()
    )
  );
create policy "application_account_links_insert_own" on public.application_account_links
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.application_accounts a
      where a.id = application_account_links.account_id and a.user_id = auth.uid()
    )
  );
create policy "application_account_links_delete_own" on public.application_account_links
  for delete using (
    auth.uid() = user_id
    and exists (
      select 1 from public.application_accounts a
      where a.id = application_account_links.account_id and a.user_id = auth.uid()
    )
  );

-- --- application_account_events -------------------------------------------

create table if not exists public.application_account_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references public.application_accounts (id) on delete cascade,
  event_type text not null check (event_type in (
    'creation_started', 'account_created', 'verification_requested', 'verification_succeeded',
    'login_succeeded', 'login_failed', 'password_rotated', 'status_check_succeeded',
    'status_check_failed', 'disabled', 'deleted'
  )),
  -- Redacted before insertion, by whichever Package 2 function writes
  -- here — this migration only enforces that inserts can't happen at
  -- all except through such a function (see the RLS note below); it
  -- can't itself enforce what's inside this jsonb.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists application_account_events_user_idx
  on public.application_account_events (user_id);
create index if not exists application_account_events_account_idx
  on public.application_account_events (account_id);

alter table public.application_account_events enable row level security;

-- Read-only from the client on purpose — deliberately no insert/update/
-- delete policy for `authenticated`/`anon`. "Inserts happen through
-- controlled server functions" (plan's own wording): a SECURITY DEFINER
-- function (Package 2) bypasses RLS entirely via its owning role, so it
-- can still write here with zero policies granting that to regular
-- users — this is an append-only audit log, not a table anyone should
-- ever be able to insert into directly.
create policy "application_account_events_select_own" on public.application_account_events
  for select using (auth.uid() = user_id);
