# Plan: Supabase for user info + documents (protected)

**Status: schema gap closed, hosted read+write sync built and wired into the desktop app (2026-08-10).** `0003_document_fields.sql` was written and pushed live to the `aplyx-users` project (ref `aedejjesqcbndphkldfs`) — operator chose Option A (jsonb/text columns, not a storage bucket: cheapest to carry forward, smallest footprint, directly queryable by any agent) and EEO option 1 (status quo, RLS only). Verified live via `supabase db query --linked`: all ten columns exist on both `applied_jobs` and `review_queue`.

`SupabaseAdapter` (`src/core/src/adapters/supabase.ts`) is no longer read-only-stub-plus-nothing:
- `loadState()` reads `jobs`/`applied_jobs`/`review_queue` for the signed-in user into a real `AplyxState`, row-mapped with the same field set the local files use (plus `fill_record`, the hosted content-not-path counterpart to `fill_record_path` — new type in `stateDerive.ts`).
- `markQueueEntryApplied()`/`dismissQueueEntry()` are hosted mirrors of `reviewActions.ts`'s local versions — same validation, same never-throws contract on dismiss, same DB-enforced status-downgrade guard (migration 0001's trigger) instead of Python's. Not added to the shared `Adapter` interface — kept as `SupabaseAdapter`-specific methods, same precedent as `readOnboardingCompleted`/`writeOnboardingCompleted`, since nothing calls them polymorphically across mode (the frontend always branches on `source` explicitly).
- A new shared hook, `src/tauri/src/lib/useAplyxState.ts`, resolves "local install wins, hosted session is the fallback, otherwise nothing" **once**, in one place, instead of four screens each re-deriving it. `HomeScreen`, `ReviewScreen`, `StatusScreen`, and `DocumentsScreen` all use it now — a hosted-only session (signed in, no local install on this machine) gets real dashboard stats/activity, a real review queue it can act on (mark applied / dismiss), and real status/documents views, not just a "connect a local install" placeholder.
- Deliberately still local-only, unchanged: live job search/apply (`JobsScreen` — needs the Python scraper + fit-gate pipeline, out of scope here and squarely Phase 17 territory), reopening a pre-filled application via Playwright (needs the user's real local Chrome), and Sheets sync on mark-applied (a local-config-reading Python helper with no hosted target).

Typechecked and built clean across core/TUI/desktop (including the desktop `vite build` — the new hook and its screen-side imports don't leak `node:fs` into the webview bundle).

## tl;dr

This is **not a greenfield design** — most of the foundation already exists and is already RLS-protected. The real gaps are: (1) the newer per-application document fields (tailored resume bullets, cover letter text, doubt signals, fill records) exist locally but were never added to the hosted schema, (2) the hosted sync code for job/application data was scaffolded but never implemented (`SupabaseAdapter.loadState()` is a stub), and (3) one field (`fill_record_path`) is a local filesystem path that has no meaning at all in a hosted context. Below is what exists, what's missing, and a concrete migration to close the gap — for review, not yet for execution.

## Two separate Supabase projects — don't conflate them

- **`src/supabase/migrations/`** — the hosted-backend project this plan is about: per-user profile data, application history, resumes. Every table is `auth.uid()`-scoped via RLS.
- **`src/job_cache_supabase/`** — a completely different project: a shared, non-user-specific cache of scraped job postings (no auth, no PII, nothing to protect at the row level since it holds no per-user data). Out of scope here; mentioned only so it isn't confused with the project below.

## What's already built (verified by reading the actual migrations + adapter code, not assumed)

`src/supabase/migrations/0001_init.sql` + `0002_onboarding_completed.sql`, consumed by `src/core/src/adapters/supabase.ts`:

| Table / bucket | Holds | Protection |
| --- | --- | --- |
| `profiles` | Name, contact info, address, work-authorization/EEO fields (`gender`, `ethnicity`, `hispanic_or_latino`, `date_of_birth`), job-search preferences (jsonb), `onboarding_completed` | RLS: select/insert/update/delete all scoped to `auth.uid() = user_id` |
| `jobs` | Canonical per-user job registry (status tracking) | RLS scoped to owner; a trigger (`jobs_guard_status_transition`) blocks a sync from silently downgrading a terminal outcome back to "new" |
| `job_events` | Append-only status-change log | RLS scoped to owner; insert-only policy (no update/delete), matching the local JSONL file's append-only discipline |
| `applied_jobs` | One row per applied job — company, title, status, ATS score, reasoning, etc. | RLS scoped to owner |
| `review_queue` | Pending human-review items | RLS scoped to owner; insert-only (append-only, same as the local file) |
| `resumes` (storage bucket, private) | Actual resume files | RLS on `storage.objects`: a user can only read/write objects under `<their-own-uid>/` — enforced by `storage.foldername(name)[1] = auth.uid()::text` |

The client (`src/tauri/src/lib/supabaseClient.ts`) uses the **anon/publishable key**, not a service-role key — correct, since protection comes from RLS policies evaluated server-side per request, not from hiding a privileged key. This is the right foundation and doesn't need to change.

**What's real vs. provisioned-but-inert:** the profile fields and the resumes bucket are actually wired up and used today (hosted onboarding wizard writes to both). The `jobs`/`job_events`/`applied_jobs`/`review_queue` tables exist and are RLS-protected, but `SupabaseAdapter.loadState()` currently just returns `undefined` with a comment marking hosted job/application sync as unbuilt ("Phase 14B scope"). So today, a hosted-only (no local install) session has no dashboard data — by design, not by bug.

## Gaps

1. ~~**Schema drift**: the local JSON shape (`AppliedJob`/`QueueEntry` in `src/core/src/stateDerive.ts`) has grown fields that predate migration 0001 and were never added to the hosted tables: `tailored_bullets` (string[]), `cover_letter` (string), `missing_keywords` (string[]), `doubt_signals` (string[]), `fill_record_path` (string). If hosted sync shipped today against the current schema, all five would silently have nowhere to go.~~ **Closed by 0003 (2026-08-10).**
2. ~~**`fill_record_path` doesn't make sense hosted.** It's a path into the *local* filesystem (`data/fill_records/<job_id>.json`, written by `record_fill.py`). A hosted row can't point at a path on someone's laptop. The hosted column needs to hold the record's actual *content*, not a path to it.~~ **Closed by 0003** — the hosted column is `fill_record` (jsonb, content), not a path.
3. **No sync implementation.** The tables/columns are necessary but not sufficient — `loadState()`/the write paths in `helpers.ts` need real code to read from and write to these tables. This plan only covers the schema; the sync code is a separate, larger follow-up (flagged, not scoped here).
4. **No hosted storage for cover letters as files**, only as an (currently missing) text column. Worth a deliberate either/or, not an oversight — see below.
5. **EEO/demographic fields have no extra protection beyond RLS.** `gender`, `ethnicity`, `hispanic_or_latino`, `date_of_birth` sit as plain columns. RLS already prevents any *other user* from reading them; the open question is whether the operator wants defense-in-depth beyond that (see options below).

## Proposed migration (draft SQL — for review, not applied)

```sql
-- 0003_document_fields.sql (draft)

alter table public.applied_jobs
  add column if not exists tailored_bullets jsonb,
  add column if not exists cover_letter text,
  add column if not exists missing_keywords jsonb,
  add column if not exists doubt_signals jsonb,
  add column if not exists fill_record jsonb;  -- content, not a path

alter table public.review_queue
  add column if not exists tailored_bullets jsonb,
  add column if not exists cover_letter text,
  add column if not exists missing_keywords jsonb,
  add column if not exists doubt_signals jsonb,
  add column if not exists fill_record jsonb;
```

Additive-only, same pattern 0002 already used (`add column if not exists`) — safe to run against existing rows (they get `null` for the new columns, no backfill required, matches how 0002 handled `onboarding_completed`). RLS is inherited automatically; no new policies needed since these are just new columns on already-protected tables.

## Open decision: do cover letters/tailored resumes need to be *files*, or is text enough?

Two real options, not a foregone conclusion:

- **Option A — text columns (the migration above).** Simplest. Fine if the hosted app only ever needs to *display* this content (e.g., a hosted-mode Documents tab), never hand someone a downloadable file.
- **Option B — a `documents` storage bucket**, mirroring `resumes`' exact pattern (private, `<uid>/` folder RLS) if the operator wants users to download an actual cover-letter file from the hosted dashboard. This is more infrastructure for a feature nobody has asked for yet — recommend starting with Option A and only adding a bucket if a real "download my cover letter" need shows up.

**Recommendation: Option A**, revisit if hosted-mode document downloads become a real feature.

## Open decision: extra protection for EEO/demographic fields

RLS already means no other *user* can read these — the question is whether to harden further against, e.g., a compromised anon key or a Supabase-side incident:

1. **Do nothing extra** (current state). RLS is the standard, correct Supabase pattern; Postgres already encrypts at rest at the infrastructure level. Most apps stop here.
2. **`pgsodium`/`pgcrypto` column-level encryption** for just the EEO fields, decrypted only client-side. Real extra protection, real extra complexity (key management, and these fields become unqueryable server-side — fine here, since nothing server-side needs to query on gender/ethnicity today).
3. **Don't sync EEO fields to hosted at all** — keep them local-only (the pre-2026-07-16 default, before the operator's own override decision, per the adapter's comment). Simplest possible "protection": the data never leaves the user's machine for anyone who signs in but doesn't need cross-device profile sync for exactly these fields.

**Recommendation: option 1 (status quo) is reasonable and matches how the rest of the schema is already protected** — flagging options 2/3 only because "protected of course" suggested the operator wants this decision made deliberately rather than by default. No action needed unless the operator wants to pick 2 or 3.

## What this plan does NOT cover (explicitly out of scope, flag separately if wanted)

- The actual sync implementation (`SupabaseAdapter.loadState()` + write paths) — schema-only here.
- `src/job_cache_supabase` — unrelated system, no user data.
- Any change to the `resumes` bucket — it's already correctly protected and unaffected by this plan.
