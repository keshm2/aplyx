-- Message matches for verification sessions. Stored service-side only.

create table if not exists public.verification_messages (
  id uuid primary key default gen_random_uuid(),
  verification_session_id uuid not null references public.verification_sessions (id) on delete cascade,
  provider_message_id text,
  thread_or_conversation_id text,
  received_at timestamptz not null,
  from_address text,
  subject_redacted text,
  snippet_redacted text,
  match_score numeric,
  extracted_kind text check (extracted_kind in ('otp', 'link', 'unknown')),
  secret_id uuid references vault.secrets (id) on delete set null,
  consumed_at timestamptz,
  retention_expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists verification_messages_session_idx
  on public.verification_messages (verification_session_id, received_at);

alter table public.verification_messages enable row level security;
-- service-role only: carries redacted inbox metadata plus secret handles.
