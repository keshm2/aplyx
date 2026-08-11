import type { SupabaseClient } from "@supabase/supabase-js";
import type { Adapter, FieldValue } from "../adapter.js";
import type { AplyxState, AppliedJob, QueueEntry, RegistryRecord } from "../state.js";
import { HOSTED_PROFILE_FIELD_IDS, HOSTED_PREFERENCE_FIELD_IDS } from "../onboarding/hostedFields.js";
import { registryByJobId, hasAppliedOrFailed, isDismissed, todayIso } from "../stateDerive.js";

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: unknown): boolean | undefined {
  return v === null || v === undefined ? undefined : Boolean(v);
}

/** jsonb columns come back already-parsed from PostgREST; a bare array/object
 *  check is enough defense against a null or unexpected shape — no JSON.parse
 *  needed (unlike the local file readers, which parse raw JSON text). */
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map((x) => String(x)) : undefined;
}

function rowToRegistryRecord(row: Row): RegistryRecord {
  return {
    job_key: String(row.job_key ?? ""),
    job_id: String(row.job_id ?? ""),
    company: str(row.company),
    title: str(row.title),
    latest_status: str(row.latest_status),
    url: str(row.url),
    internship_term: str(row.internship_term),
  };
}

/** Shared by rowToAppliedJob/rowToQueueEntry — every column the two tables
 *  have in common (see migrations 0001/0003; review_queue additionally omits
 *  applied_jobs' NOT NULL constraints, not any columns). */
function rowToAppliedJobFields(row: Row): Omit<AppliedJob, "status"> {
  return {
    job_id: String(row.job_id ?? ""),
    company: String(row.company ?? ""),
    title: String(row.title ?? ""),
    url: String(row.url ?? ""),
    apply_url: str(row.apply_url),
    date_applied: String(row.date_applied ?? ""),
    role_type: str(row.role_type),
    source: str(row.source),
    resume_used: str(row.resume_used),
    ats_score: num(row.ats_score),
    location_tier: str(row.location_tier),
    cover_letter_used: bool(row.cover_letter_used),
    reasoning: str(row.reasoning),
    tailored_bullets: strArray(row.tailored_bullets),
    cover_letter: str(row.cover_letter),
    missing_keywords: strArray(row.missing_keywords),
    doubt_signals: strArray(row.doubt_signals),
    // fill_record_path intentionally omitted — hosted rows never have a
    // local filesystem path; fill_record (content) is the hosted analog.
    fill_record: (row.fill_record as AppliedJob["fill_record"]) ?? undefined,
  };
}

/** applied_jobs.status is DB-constrained to these three values (migration
 *  0001's check constraint) — anything else means schema drift, not a value
 *  worth silently coercing (matches the "never silently guess" pattern
 *  elsewhere, e.g. checkJobFit's fit_status validation in jobs.ts). */
function rowToAppliedJob(row: Row): AppliedJob {
  const status = String(row.status ?? "");
  if (status !== "applied" && status !== "failed" && status !== "needs_review") {
    throw new Error(`applied_jobs row ${String(row.job_id)} has unexpected status '${status}'`);
  }
  return { ...rowToAppliedJobFields(row), status };
}

function rowToQueueEntry(row: Row): QueueEntry {
  return { ...rowToAppliedJobFields(row), status: str(row.status) };
}

/**
 * Hosted-mode adapter: talks directly to Supabase (HTTPS to supabase.co,
 * no local server involved) via @supabase/supabase-js, scoped to the
 * signed-in user by `user_id` — enforced twice over, by this adapter's
 * queries and by the `profiles` table's row-level security policy.
 *
 * Field routing: the safe_fields-shaped PII (HOSTED_PROFILE_FIELD_IDS) maps
 * one column per field on `profiles`, per the operator's explicit decision
 * to sync profile PII for signed-in users (2026-07-16, overriding phase
 * 11's original local-only-PII default — see onboarding/profile.ts).
 * Job-search preferences (HOSTED_PREFERENCE_FIELD_IDS — role_keywords,
 * preferred_locations, target_companies) live in a single `preferences`
 * jsonb column instead: they aren't PII, and they only become meaningful
 * once synced into a local install's src/config/targets.json for the Python
 * fit-gate engine to read (Phase 14B), so a flexible column avoids a
 * schema migration once that sync direction is built.
 */
export class SupabaseAdapter implements Adapter {
  readonly mode = "hosted" as const;

  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string,
  ) {}

  private async readRow(): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("profiles")
      .select("*")
      .eq("user_id", this.userId)
      .maybeSingle();
    if (error) throw error;
    return (data as Row | null) ?? undefined;
  }

  async readProfileField(id: string): Promise<FieldValue> {
    const row = await this.readRow();
    if (HOSTED_PREFERENCE_FIELD_IDS.includes(id)) {
      const prefs = (row?.preferences as Record<string, string[]> | undefined) ?? {};
      return prefs[id] ?? [];
    }
    if (!HOSTED_PROFILE_FIELD_IDS.includes(id)) {
      throw new Error(`unknown profile field: ${id}`);
    }
    return String(row?.[id] ?? "");
  }

  async writeProfileField(id: string, value: FieldValue): Promise<void> {
    if (HOSTED_PREFERENCE_FIELD_IDS.includes(id)) {
      const row = await this.readRow();
      const prefs = { ...((row?.preferences as Record<string, string[]> | undefined) ?? {}), [id]: value };
      const { error } = await this.client
        .from("profiles")
        .upsert({ user_id: this.userId, preferences: prefs }, { onConflict: "user_id" });
      if (error) throw error;
      return;
    }
    if (!HOSTED_PROFILE_FIELD_IDS.includes(id)) {
      throw new Error(`unknown profile field: ${id}`);
    }
    const { error } = await this.client
      .from("profiles")
      .upsert({ user_id: this.userId, [id]: value }, { onConflict: "user_id" });
    if (error) throw error;
  }

  /** Whether this signed-in user has finished the hosted onboarding wizard
   *  before — drives the desktop app's post-sign-in landing (dashboard vs
   *  wizard) so a returning sign-in doesn't repeat it every time. */
  async readOnboardingCompleted(): Promise<boolean> {
    const row = await this.readRow();
    return Boolean(row?.onboarding_completed);
  }

  async writeOnboardingCompleted(completed: boolean): Promise<void> {
    const { error } = await this.client
      .from("profiles")
      .upsert({ user_id: this.userId, onboarding_completed: completed }, { onConflict: "user_id" });
    if (error) throw error;
  }

  /**
   * Reads the three pipeline tables (jobs/applied_jobs/review_queue) for
   * this signed-in user, RLS-scoped the same way readRow() is. Ordered by
   * created_at ascending to match the local files' natural order (each is
   * append-only on write, so array order there is already chronological —
   * see stateDerive.ts's isResolved/hasAppliedOrFailed comments, which
   * assume no particular order but this keeps behavior identical to local
   * mode for anything that does care, e.g. "most recent" derivations).
   *
   * job_events (the append-only event log) is deliberately NOT read here —
   * nothing in AplyxState surfaces it (state.ts's local loadState() doesn't
   * read data/job_events.jsonl either), it exists purely as an audit trail
   * both locally and hosted.
   *
   * A signed-in user with zero rows yet (brand new account) gets a real
   * (empty-array) AplyxState, not undefined — undefined is reserved for a
   * genuine fetch failure (which actually throws below, same as every
   * other method on this class; the `| undefined` in the return type
   * exists only to satisfy the shared Adapter interface, which LocalAdapter
   * needs it for — a local install that was never found has nothing to
   * return but isn't an error).
   */
  /**
   * Pages through every row of one table for this user via PostgREST's
   * Range header, not a single unbounded .select("*"). PostgREST caps an
   * unranged select at a server-side default (1,000 rows on this
   * project) — a single .select() silently returning only the OLDEST
   * 1,000 rows (order is created_at ascending) is not a hypothetical:
   * confirmed live during Phase 17 worker verification (2026-08-10) once
   * a test account's `jobs` registry passed 1,000 rows, every run after
   * that point re-detected everything past row 1,000 as "new" — a hosted
   * worker checking loadState()'s registry for already-processed job_keys
   * would spend every future run re-fit-gating and re-writing thousands
   * of already-decided jobs, and (this table alone has no per-job unique
   * constraint) produced a real duplicate row in review_queue, visible in
   * the desktop app's Review screen, before this fix. 1,000 rows/page,
   * looping until a page comes back short — safe for any registry size,
   * not just accounts small enough to fit under the old silent cap.
   */
  private async fetchAllRows(table: string): Promise<Row[]> {
    const pageSize = 1000;
    const rows: Row[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await this.client
        .from(table)
        .select("*")
        .eq("user_id", this.userId)
        .order("created_at", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = (data ?? []) as Row[];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  async loadState(): Promise<AplyxState | undefined> {
    const [jobsRows, appliedRows, queueRows] = await Promise.all([
      this.fetchAllRows("jobs"),
      this.fetchAllRows("applied_jobs"),
      this.fetchAllRows("review_queue"),
    ]);

    return {
      registry: jobsRows.map(rowToRegistryRecord),
      applied: appliedRows.map(rowToAppliedJob),
      queue: queueRows.map(rowToQueueEntry),
    };
  }

  /** Inserts a job_events row and updates jobs.latest_status to match —
   *  the hosted equivalent of job_state.py's record-event, which does both
   *  in one call locally. Not transactional (two separate requests), same
   *  as the local helper (two separate file writes) — this is a faithful
   *  mirror of existing behavior, not a regression. The UPDATE relies on
   *  migration 0001's jobs_guard_status_transition trigger to refuse
   *  silently downgrading a blocking status (applied/needs_review/failed/
   *  skipped_unfit) back to new/seen — the same guard job_state.py's
   *  Python implements, enforced here at the DB layer instead. */
  private async recordJobEvent(
    jobKey: string,
    status: string,
    reasoning: string,
    company: string,
    title: string,
    url: string,
  ): Promise<void> {
    const { error: insertError } = await this.client
      .from("job_events")
      .insert({ user_id: this.userId, job_key: jobKey, status, reasoning, company, title, url });
    if (insertError) throw insertError;
    const { error: updateError } = await this.client
      .from("jobs")
      .update({ latest_status: status })
      .eq("user_id", this.userId)
      .eq("job_key", jobKey);
    if (updateError) throw updateError;
  }

  /**
   * Hosted mirror of reviewActions.ts's markQueueEntryApplied — same
   * validation (throws on missing registry linkage or required fields,
   * never fabricates values), same shape of applied_jobs record. Two
   * deliberate differences from the local version: no Sheets sync (that's
   * a Python helper reading local config; hosted mode has no sync target
   * for it), and a duplicate insert (job_id already applied — PK violation,
   * Postgres code 23505) resolves to a friendly "already recorded" message
   * instead of throwing, mirroring how the local append-only helper's own
   * dedup guard degrades to a non-error outcome.
   */
  async markQueueEntryApplied(entry: QueueEntry): Promise<QueueActionResult> {
    const state = await this.loadState();
    const reg = state && registryByJobId(state.registry, entry.job_id);
    if (!reg?.job_key) {
      throw new Error(
        `Cannot mark applied: no registry record / job_key for "${entry.company} — ${entry.title}" (job_id=${entry.job_id}). Canonicalize the job first.`,
      );
    }
    const missing: string[] = [];
    if (!entry.job_id) missing.push("job_id");
    if (!entry.company) missing.push("company");
    if (!entry.title) missing.push("title");
    if (!entry.url) missing.push("url");
    if (!entry.role_type) missing.push("role_type");
    if (!entry.source) missing.push("source");
    if (!entry.resume_used) missing.push("resume_used");
    if (typeof entry.ats_score !== "number") missing.push("ats_score");
    if (!entry.location_tier) missing.push("location_tier");
    if (missing.length > 0) {
      throw new Error(
        `Cannot mark applied: missing required field(s) ${missing.join(", ")} for "${entry.company ?? entry.job_id}". Refusing to fabricate values.`,
      );
    }
    const reasoning = "Marked applied manually via review-queue triage";
    const { error: insertError } = await this.client.from("applied_jobs").insert({
      user_id: this.userId,
      job_id: entry.job_id,
      company: entry.company,
      title: entry.title,
      url: entry.url,
      date_applied: todayIso(),
      status: "applied",
      role_type: entry.role_type,
      source: entry.source,
      resume_used: entry.resume_used,
      ats_score: entry.ats_score,
      location_tier: entry.location_tier,
      cover_letter_used: entry.cover_letter_used ?? false,
      reasoning,
    });
    if (insertError) {
      if (insertError.code === "23505") {
        return { message: `Already recorded: ${entry.company} — ${entry.title}` };
      }
      throw insertError;
    }
    await this.recordJobEvent(reg.job_key, "applied", reasoning, entry.company, entry.title, entry.url);
    return { message: `Recorded applied: ${entry.company} — ${entry.title}` };
  }

  /**
   * Upserts one registry row (the hosted mirror of job_state.py's
   * upsert_job) — called by the hosted worker (src/worker/) before every
   * fit-gate/tailor decision, exactly like the local pipeline canonicalizes
   * and registers a job before deciding its fate. Keyed on (user_id,
   * job_key) — a re-run that sees the same posting again is a no-op merge,
   * not a duplicate row, matching upsert_job's own dedup semantics.
   */
  async registerJob(record: {
    job_key: string;
    job_id: string;
    company: string;
    title: string;
    url: string;
    internship_term?: string;
  }): Promise<void> {
    const { error } = await this.client
      .from("jobs")
      .upsert({ user_id: this.userId, ...record }, { onConflict: "user_id,job_key" });
    if (error) throw error;
  }

  /**
   * Hosted mirror of the local skipped_unfit path (job-scraper.md Phase 1
   * step 10) — registers the job and records the event so a future worker
   * run doesn't re-fetch/re-fit-gate/re-spend an Anthropic call on it, but
   * deliberately never writes applied_jobs/review_queue: skipped_unfit is
   * local-only outcome vocabulary (CLAUDE.md "Conventions that trip people
   * up"), true for hosted rows too.
   */
  async recordSkippedUnfit(
    record: { job_key: string; job_id: string; company: string; title: string; url: string; internship_term?: string },
    reasoning: string,
  ): Promise<void> {
    await this.registerJob(record);
    await this.recordJobEvent(record.job_key, "skipped_unfit", reasoning, record.company, record.title, record.url);
  }

  /**
   * Hosted mirror of the local needs_review write (job-scraper.md Phase 1
   * step 10 / Phase 2 step 3): registers the job, records a needs_review
   * event, and writes the SAME entry payload into both applied_jobs (status
   * needs_review — mirrors the local dual-write into data/applied_jobs.json)
   * and review_queue, so it shows up in the desktop app's Review screen.
   * review_only mode never auto-applies, so every tailored candidate lands
   * here for the user to act on manually — not just the ambiguous fit-gate
   * outcome — `reasoning` is the caller's job to make specific to which of
   * those two cases this actually is.
   *
   * Duplicate-insert tolerance (Postgres 23505) mirrors
   * markQueueEntryApplied's own dedup guard — defensive here since the
   * worker is expected to skip already-registered job_keys before ever
   * reaching this call, not the primary dedup mechanism.
   */
  async saveJobForReview(
    record: { job_key: string; job_id: string; company: string; title: string; url: string; internship_term?: string },
    entry: QueueEntry,
    reasoning: string,
  ): Promise<void> {
    await this.registerJob(record);
    await this.recordJobEvent(record.job_key, "needs_review", reasoning, record.company, record.title, record.url);
    const payload = {
      user_id: this.userId,
      job_id: entry.job_id,
      company: entry.company,
      title: entry.title,
      url: entry.url,
      apply_url: entry.apply_url,
      date_applied: entry.date_applied,
      status: "needs_review",
      role_type: entry.role_type,
      source: entry.source,
      resume_used: entry.resume_used,
      ats_score: entry.ats_score,
      location_tier: entry.location_tier,
      cover_letter_used: entry.cover_letter_used ?? false,
      reasoning: entry.reasoning,
      tailored_bullets: entry.tailored_bullets,
      cover_letter: entry.cover_letter,
      missing_keywords: entry.missing_keywords,
      doubt_signals: entry.doubt_signals,
    };
    const { error: appliedError } = await this.client.from("applied_jobs").insert(payload);
    if (appliedError && appliedError.code !== "23505") throw appliedError;
    const { error: queueError } = await this.client.from("review_queue").insert(payload);
    if (queueError) throw queueError;
  }

  /** Hosted mirror of reviewActions.ts's dismissQueueEntry — same
   *  never-throws contract (every failure mode comes back as a displayable
   *  message, not an exception), same guard order. */
  async dismissQueueEntry(entry: QueueEntry): Promise<QueueActionResult> {
    const state = await this.loadState();
    if (state && hasAppliedOrFailed(state, entry)) {
      return {
        message: `Cannot dismiss: "${entry.company} — ${entry.title}" already has an applied/failed outcome; dismiss would overwrite it with skipped_unfit.`,
      };
    }
    if (state && isDismissed(state, entry)) {
      return { message: `Already dismissed: "${entry.company} — ${entry.title}" is already marked skipped_unfit.` };
    }
    const reg = state && registryByJobId(state.registry, entry.job_id);
    if (!reg?.job_key) {
      return { message: "Cannot dismiss: no registry record for this job (no job_key to record against)." };
    }
    await this.recordJobEvent(
      reg.job_key,
      "skipped_unfit",
      "Dismissed by operator in review-queue triage",
      entry.company,
      entry.title,
      entry.url,
    );
    return { message: `Dismissed: ${entry.company} — ${entry.title}` };
  }
}

export interface QueueActionResult {
  message: string;
}
