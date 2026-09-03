import type { SupabaseClient } from "@supabase/supabase-js";
import type { Adapter, FieldValue } from "../adapter.js";
import type { AplyxState, AppliedJob, ApplyRunSummary, ApplyRunStatus, QueueEntry, RegistryRecord } from "../state.js";
import type { FillRecord } from "../stateDerive.js";
import { HOSTED_PROFILE_FIELD_IDS, HOSTED_PREFERENCE_FIELD_IDS } from "../onboarding/hostedFields.js";
import { registryByJobId, hasAppliedOrFailed, isDismissed, todayIso } from "../stateDerive.js";
import type { AtsFamily } from "../atsRegistry.js";
import { isTerminal, transition } from "../applyStateMachine.js";

type Row = Record<string, unknown>;

export interface ManagedAliasRow {
  id: string;
  family: AtsFamily;
  alias: string;
  forwarding_to: string;
  status: "active" | "disabled";
  created_at?: string;
  updated_at?: string;
}

export interface InboundEmailRow {
  id: string;
  alias_id: string;
  apply_run_id?: string;
  from_address: string;
  subject: string;
  body_text: string;
  parsed_otp?: string;
  parsed_link?: string;
  classified_status?: string;
  forwarded_at?: string;
  consumed_at?: string;
  received_at: string;
}

export interface MailConnectionRow {
  id: string;
  provider: "gmail" | "microsoft" | "imap";
  email_address: string;
  auth_method: "oauth" | "app_password";
  status: "connected" | "reauth_required" | "failed" | "revoked";
  scopes: string[];
  provider_account_id?: string;
  watch_state?: Record<string, unknown>;
  last_health_error?: string;
  connected_at?: string;
  revoked_at?: string;
  updated_at?: string;
}

export interface VerificationSessionRow {
  id: string;
  apply_run_id?: string;
  job_id: string;
  family: AtsFamily;
  tenant_key?: string;
  company?: string;
  candidate_email: string;
  mail_connection_id?: string;
  status: "created" | "watching" | "message_found" | "secret_ready" | "consumed" | "resumed" | "manual_required" | "expired" | "failed" | "canceled";
  challenge_type: "otp" | "link" | "either" | "unknown";
  expected_sender_domains: string[];
  expected_subject_tokens: string[];
  detection_started_at?: string;
  expires_at?: string;
  attempt_count: number;
  last_poll_at?: string;
  resolved_at?: string;
  failure_reason?: string;
  checkpoint: Record<string, unknown>;
  updated_at?: string;
}

/** Full redacted detail for one session (get_own_verification_session).
 *  `has_secret` is true when an unconsumed Vault secret exists; the raw
 *  value is only ever returned by consumeVerificationSecret, never here. */
export interface VerificationSessionDetail {
  id: string;
  job_id: string;
  family: AtsFamily;
  tenant_key?: string;
  company?: string;
  candidate_email: string;
  mail_connection_id?: string;
  apply_run_id?: string;
  status: VerificationSessionRow["status"];
  challenge_type: VerificationSessionRow["challenge_type"];
  expected_sender_domains: string[];
  expected_subject_tokens: string[];
  expires_at?: string;
  attempt_count: number;
  last_poll_at?: string;
  resolved_at?: string;
  failure_reason?: string;
  has_secret: boolean;
  message_extracted_kind?: "otp" | "link" | "unknown";
  created_at?: string;
  updated_at?: string;
}

/** Bounded-poll result (poll_own_verification_session): the redacted
 *  state after bumping attempt_count/last_poll_at and auto-expiring. */
export interface VerificationSessionPoll {
  status: VerificationSessionRow["status"];
  has_secret: boolean;
  message_extracted_kind?: "otp" | "link" | "unknown";
  attempt_count: number;
  expires_at?: string;
  failure_reason?: string;
}

/** get_application_account_metadata's shape (migration 0028): masked
 *  display fields only. `login_hint` is a masked value ("j***@company.com"),
 *  never the real login identifier; there is no username/password field
 *  here at all, by construction (see docs/ats-account-credentials-plan.md
 *  Package 6: "credentials are masked by default"). */
export interface ApplicationAccountRow {
  id: string;
  company_name: string;
  ats_family: AtsFamily;
  tenant_key: string;
  login_hint?: string;
  status: string;
  verification_status: string;
  status_tracking_enabled: boolean;
  last_login_at?: string;
  last_status_check_at?: string;
}

export interface HostedReadiness {
  candidateEmail: string;
  hasCandidateEmail: boolean;
  inboxConnected: boolean;
  inboxProvider?: string;
  inboxStatus?: string;
  resumeUploaded: boolean;
  verificationFallbackReady: boolean;
}

export interface CreateApplyRunInput {
  jobId: string;
  family: AtsFamily;
  aliasId?: string;
  /** The application_accounts row (migration 0027/0028) this run is
   *  tied to, for account-required families. Never a credential: the
   *  caller resolves this via createOrReuseApplicationAccount first. */
  accountId?: string;
  tailoredResumeAttached?: boolean;
  tailoredResumeArtifactPath?: string;
  fillPlan?: unknown;
  checkpoint?: unknown;
  screenshotUrl?: string;
  status?: ApplyRunStatus;
  approvalState?: "pending" | "approved" | "rejected";
}

export interface SaveReadyToSubmitOptions {
  family: AtsFamily;
  fillRecord?: FillRecord;
  fillPlan?: unknown;
  checkpoint?: unknown;
  screenshotUrl?: string;
  tailoredResumeArtifactPath?: string;
  aliasId?: string;
  accountId?: string;
}

export interface CreateOrReuseApplicationAccountInput {
  family: AtsFamily;
  /** Normalized tenant identifier: use atsRegistry.ts's tenantKeyFor so
   *  every caller keys on the exact same value (required for the
   *  RPC's own dedup to actually dedupe). */
  tenantKey: string;
  companyName: string;
  username: string;
  password: string;
  managedAliasId?: string;
}

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

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** jsonb columns come back already-parsed from PostgREST; a bare array/object
 *  check is enough defense against a null or unexpected shape: no JSON.parse
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

/** Shared by rowToAppliedJob/rowToQueueEntry: every column the two tables
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
    // fill_record_path intentionally omitted: hosted rows never have a
    // local filesystem path; fill_record (content) is the hosted analog.
    fill_record: (row.fill_record as AppliedJob["fill_record"]) ?? undefined,
    screenshot_path: str(row.screenshot_path),
    screenshot_url: str(row.screenshot_url),
    apply_run_id: str(row.apply_run_id),
    // Written directly onto this row by email-tracking-worker
    // (src/supabase/functions/email-tracking-worker/), guarded by the
    // applied_jobs_outcome_transition_guard DB trigger (migration 0007):
    // unlike local mode, there's no client-side derivation step here,
    // the column already holds the authoritative current value.
    outcome_status: row.outcome_status as AppliedJob["outcome_status"],
    outcome_updated_at: str(row.outcome_updated_at),
    outcome_source: str(row.outcome_source),
    outcome_assessment_url: str(row.outcome_assessment_url),
    outcome_assessment_note: str(row.outcome_assessment_note),
  };
}

/** applied_jobs.status is DB-constrained to these three values (migration
 *  0001's check constraint): anything else means schema drift, not a value
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

function rowToApplyRunSummary(row: Row): ApplyRunSummary {
  return {
    runId: String(row.id ?? ""),
    status: String(row.status ?? "initialized") as ApplyRunStatus,
    family: str(row.family),
    aliasId: str(row.alias_id),
    accountId: str(row.account_id),
    tailoredResumeAttached: bool(row.tailored_resume_attached),
    approvalState: (str(row.approval_state) as ApplyRunSummary["approvalState"]) ?? undefined,
    updatedAt: str(row.updated_at) ?? str(row.created_at),
    fillPlanRef: str(row.id) ? `apply_run:${String(row.id)}` : undefined,
    screenshotUrl: str(row.screenshot_url),
    tailoredResumeArtifactPath: str(row.tailored_resume_artifact_path),
  };
}

function attachApplyRun<T extends AppliedJob | QueueEntry>(entry: T, run?: ApplyRunSummary): T {
  if (!run) return entry;
  return {
    ...entry,
    apply_run: run,
    screenshot_url: entry.screenshot_url ?? run.screenshotUrl,
  };
}

function latestApplyRunsByJob(rows: Row[]): Map<string, ApplyRunSummary> {
  const byJob = new Map<string, ApplyRunSummary>();
  for (const row of rows) {
    const jobId = String(row.job_id ?? "");
    if (!jobId) continue;
    const summary = rowToApplyRunSummary(row);
    const current = byJob.get(jobId);
    if (!current) {
      byJob.set(jobId, summary);
      continue;
    }
    const currentTs = Date.parse(current.updatedAt ?? "") || 0;
    const nextTs = Date.parse(summary.updatedAt ?? "") || 0;
    if (nextTs >= currentTs) byJob.set(jobId, summary);
  }
  return byJob;
}

function normalizeAliasLocalPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/**
 * Hosted-mode adapter: talks directly to Supabase (HTTPS to supabase.co,
 * no local server involved) via @supabase/supabase-js, scoped to the
 * signed-in user by `user_id`: enforced twice over, by this adapter's
 * queries and by the `profiles` table's row-level security policy.
 *
 * Field routing: the safe_fields-shaped PII (HOSTED_PROFILE_FIELD_IDS) maps
 * one column per field on `profiles`, per the operator's explicit decision
 * to sync profile PII for signed-in users (2026-07-16, overriding phase
 * 11's original local-only-PII default; see onboarding/profile.ts).
 * Job-search preferences (HOSTED_PREFERENCE_FIELD_IDS: role_keywords,
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
   *  before: drives the desktop app's post-sign-in landing (dashboard vs
   *  wizard) so a returning sign-in doesn't repeat it every time. */
  async readOnboardingCompleted(): Promise<boolean> {
    const row = await this.readRow();
    return Boolean(row?.onboarding_completed);
  }

  async readCandidateEmail(): Promise<string> {
    const value = await this.readProfileField("email");
    return typeof value === "string" ? value.trim() : "";
  }

  async writeCandidateEmail(email: string): Promise<void> {
    await this.writeProfileField("email", email.trim());
  }

  async writeOnboardingCompleted(completed: boolean): Promise<void> {
    const { error } = await this.client
      .from("profiles")
      .upsert({ user_id: this.userId, onboarding_completed: completed }, { onConflict: "user_id" });
    if (error) throw error;
  }

  /** Stamps profiles.app_last_seen_at = now() so aplyx.app knows this
   *  account has a desktop-app install and can stop showing its "Install
   *  aplyx" prompt (migration 0042). Called fire-and-forget from the auth
   *  layer on every sign-in; a failure here must never block sign-in, so
   *  callers should swallow the rejection. */
  async touchAppLastSeen(): Promise<void> {
    const { error } = await this.client
      .from("profiles")
      .upsert(
        { user_id: this.userId, app_last_seen_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) throw error;
  }

  async listMailConnections(): Promise<MailConnectionRow[]> {
    try {
      const { data, error } = await this.client
        .from("mail_connections")
        .select("*")
        .eq("user_id", this.userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Row[]).map((row) => ({
        id: String(row.id ?? ""),
        provider: String(row.provider ?? "imap") as MailConnectionRow["provider"],
        email_address: String(row.email_address ?? ""),
        auth_method: String(row.auth_method ?? "app_password") as MailConnectionRow["auth_method"],
        status: String(row.status ?? "failed") as MailConnectionRow["status"],
        scopes: strArray(row.scopes) ?? [],
        provider_account_id: str(row.provider_account_id),
        watch_state: obj(row.watch_state),
        last_health_error: str(row.last_health_error),
        connected_at: str(row.connected_at),
        revoked_at: str(row.revoked_at),
        updated_at: str(row.updated_at),
      }));
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "42P01") return [];
      throw error;
    }
  }

  async getInboxConnection(): Promise<MailConnectionRow | undefined> {
    const rows = await this.listMailConnections();
    const connected = rows.find((row) => row.status === "connected");
    if (connected) return connected;
    const fallback = await this.selectMaybeSingleIfExists("email_tracking_config", { user_id: this.userId });
    if (!fallback || !bool(fallback.enabled)) return undefined;
    return {
      id: "email_tracking_config",
      provider: "imap",
      email_address: String(fallback.email ?? ""),
      auth_method: "app_password",
      status: "connected",
      scopes: ["imap:readonly"],
      last_health_error: undefined,
      connected_at: str(fallback.updated_at),
      updated_at: str(fallback.updated_at),
    };
  }

  async saveImapInboxConnection(input: {
    provider: "gmail" | "microsoft" | "imap";
    email: string;
    imapServer: string;
    imapPort?: number;
    appPassword: string;
  }): Promise<MailConnectionRow> {
    const port = input.imapPort ?? 993;
    const { error: rpcError } = await this.client.rpc("set_email_tracking_config", {
      p_enabled: true,
      p_email: input.email,
      p_imap_server: input.imapServer,
      p_imap_port: port,
      p_app_password: input.appPassword,
    });
    if (rpcError) throw rpcError;
    try {
      const { data, error } = await this.client
        .from("mail_connections")
        .upsert({
          user_id: this.userId,
          provider: input.provider,
          email_address: input.email,
          auth_method: "app_password",
          status: "connected",
          scopes: ["imap:readonly"],
          connected_at: new Date().toISOString(),
          watch_state: { imap_server: input.imapServer, imap_port: port },
        }, { onConflict: "user_id,provider,email_address" })
        .select("*")
        .maybeSingle();
      if (error) throw error;
      const row = (data ?? {}) as Row;
      return {
        id: String(row.id ?? ""),
        provider: String(row.provider ?? input.provider) as MailConnectionRow["provider"],
        email_address: String(row.email_address ?? input.email),
        auth_method: String(row.auth_method ?? "app_password") as MailConnectionRow["auth_method"],
        status: String(row.status ?? "connected") as MailConnectionRow["status"],
        scopes: strArray(row.scopes) ?? ["imap:readonly"],
        watch_state: obj(row.watch_state),
        connected_at: str(row.connected_at),
        updated_at: str(row.updated_at),
      };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "42P01") {
        return {
          id: "email_tracking_config",
          provider: input.provider,
          email_address: input.email,
          auth_method: "app_password",
          status: "connected",
          scopes: ["imap:readonly"],
          watch_state: { imap_server: input.imapServer, imap_port: port },
          connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      throw error;
    }
  }

  /** Marks one mail_connections row revoked: the RLS "update own" policy
   *  (0015_mail_connections.sql) lets the signed-in user do this directly,
   *  no service-role RPC needed. Leaves the Vault-stored tokens in place
   *  (only the service role can touch vault.secrets); getInboxConnection()
   *  already only matches status === "connected", so a revoked row simply
   *  stops counting as the active connection. */
  async disconnectMailConnection(id: string): Promise<void> {
    const { error } = await this.client
      .from("mail_connections")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("user_id", this.userId)
      .eq("id", id);
    if (error) throw error;
  }

  /** Revokes any other still-"connected" row for this provider once a new
   *  one just succeeded (mail-oauth-callback upserts by (user, provider,
   *  email); reconnecting under a *different* email inserts a second row
   *  rather than replacing the first, so without this a stale connection
   *  could keep counting as "connected" alongside the new one). Called
   *  right after a successful reconnect, keyed off the email that just
   *  came back through the OAuth callback. */
  async supersedeMailConnections(provider: string, keepEmailAddress: string): Promise<void> {
    const { error } = await this.client
      .from("mail_connections")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("user_id", this.userId)
      .eq("provider", provider)
      .eq("status", "connected")
      .neq("email_address", keepEmailAddress);
    if (error) throw error;
  }

  async listVerificationSessions(limit = 10): Promise<VerificationSessionRow[]> {
    try {
      const { data, error } = await this.client
        .from("verification_sessions")
        .select("*")
        .eq("user_id", this.userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as Row[]).map((row) => ({
        id: String(row.id ?? ""),
        apply_run_id: str(row.apply_run_id),
        job_id: String(row.job_id ?? ""),
        family: String(row.family ?? "workday") as AtsFamily,
        tenant_key: str(row.tenant_key),
        company: str(row.company),
        candidate_email: String(row.candidate_email ?? ""),
        mail_connection_id: str(row.mail_connection_id),
        status: String(row.status ?? "created") as VerificationSessionRow["status"],
        challenge_type: String(row.challenge_type ?? "unknown") as VerificationSessionRow["challenge_type"],
        expected_sender_domains: strArray(row.expected_sender_domains) ?? [],
        expected_subject_tokens: strArray(row.expected_subject_tokens) ?? [],
        detection_started_at: str(row.detection_started_at),
        expires_at: str(row.expires_at),
        attempt_count: num(row.attempt_count) ?? 0,
        last_poll_at: str(row.last_poll_at),
        resolved_at: str(row.resolved_at),
        failure_reason: str(row.failure_reason),
        checkpoint: obj(row.checkpoint) ?? {},
        updated_at: str(row.updated_at),
      }));
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "42P01") return [];
      throw error;
    }
  }

  async readHostedReadiness(): Promise<HostedReadiness> {
    const candidateEmail = await this.readCandidateEmail();
    const inbox = await this.getInboxConnection();
    let resumeUploaded = false;
    try {
      const { data, error } = await this.client.storage.from("resumes").list(this.userId);
      if (error) throw error;
      resumeUploaded = ((data ?? []).filter((entry) => entry.name && !entry.name.startsWith(".")).length > 0);
    } catch {
      resumeUploaded = false;
    }
    return {
      candidateEmail,
      hasCandidateEmail: Boolean(candidateEmail),
      inboxConnected: inbox?.status === "connected",
      inboxProvider: inbox?.provider,
      inboxStatus: inbox?.status,
      resumeUploaded,
      verificationFallbackReady: inbox?.status === "connected",
    };
  }

  /**
   * Reads the three pipeline tables (jobs/applied_jobs/review_queue) for
   * this signed-in user, RLS-scoped the same way readRow() is. Ordered by
   * created_at ascending to match the local files' natural order (each is
   * append-only on write, so array order there is already chronological;
   * see stateDerive.ts's isResolved/hasAppliedOrFailed comments, which
   * assume no particular order but this keeps behavior identical to local
   * mode for anything that does care, e.g. "most recent" derivations).
   *
   * job_events (the append-only event log) is deliberately NOT read here:
   * nothing in AplyxState surfaces it (state.ts's local loadState() doesn't
   * read data/job_events.jsonl either), it exists purely as an audit trail
   * both locally and hosted.
   *
   * A signed-in user with zero rows yet (brand new account) gets a real
   * (empty-array) AplyxState, not undefined; undefined is reserved for a
   * genuine fetch failure (which actually throws below, same as every
   * other method on this class; the `| undefined` in the return type
   * exists only to satisfy the shared Adapter interface, which LocalAdapter
   * needs it for: a local install that was never found has nothing to
   * return but isn't an error).
   */
  /**
   * Pages through every row of one table for this user via PostgREST's
   * Range header, not a single unbounded .select("*"). PostgREST caps an
   * unranged select at a server-side default (1,000 rows on this
   * project): a single .select() silently returning only the OLDEST
   * 1,000 rows (order is created_at ascending) is not a hypothetical:
   * confirmed live during Phase 17 worker verification (2026-08-10) once
   * a test account's `jobs` registry passed 1,000 rows, every run after
   * that point re-detected everything past row 1,000 as "new": a hosted
   * worker checking loadState()'s registry for already-processed job_keys
   * would spend every future run re-fit-gating and re-writing thousands
   * of already-decided jobs, and (this table alone has no per-job unique
   * constraint) produced a real duplicate row in review_queue, visible in
   * the desktop app's Review screen, before this fix. 1,000 rows/page,
   * looping until a page comes back short: safe for any registry size,
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

  private async fetchAllRowsIfExists(table: string): Promise<Row[]> {
    try {
      return await this.fetchAllRows(table);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "42P01") return [];
      throw error;
    }
  }

  private async selectMaybeSingleIfExists(table: string, filters: Record<string, unknown>): Promise<Row | undefined> {
    try {
      let query = this.client.from(table).select("*");
      for (const [key, value] of Object.entries(filters)) {
        query = query.eq(key, value);
      }
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return (data as Row | null) ?? undefined;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "42P01") return undefined;
      throw error;
    }
  }

  async loadState(): Promise<AplyxState | undefined> {
    const [jobsRows, appliedRows, queueRows, applyRunRows] = await Promise.all([
      this.fetchAllRows("jobs"),
      this.fetchAllRows("applied_jobs"),
      this.fetchAllRows("review_queue"),
      this.fetchAllRowsIfExists("apply_runs"),
    ]);

    const applyRuns = latestApplyRunsByJob(applyRunRows);

    return {
      registry: jobsRows.map(rowToRegistryRecord),
      applied: appliedRows.map((row) => attachApplyRun(rowToAppliedJob(row), applyRuns.get(String(row.job_id ?? "")))),
      queue: queueRows.map((row) => attachApplyRun(rowToQueueEntry(row), applyRuns.get(String(row.job_id ?? "")))),
    };
  }

  /** Inserts a job_events row and updates jobs.latest_status to match:
   *  the hosted equivalent of job_state.py's record-event, which does both
   *  in one call locally. Not transactional (two separate requests), same
   *  as the local helper (two separate file writes); this is a faithful
   *  mirror of existing behavior, not a regression. The UPDATE relies on
   *  migration 0001's jobs_guard_status_transition trigger to refuse
   *  silently downgrading a blocking status (applied/needs_review/failed/
   *  skipped_unfit) back to new/seen, the same guard job_state.py's
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
   * Hosted mirror of reviewActions.ts's markQueueEntryApplied: same
   * validation (throws on missing registry linkage or required fields,
   * never fabricates values), same shape of applied_jobs record. Two
   * deliberate differences from the local version: no Sheets sync (that's
   * a Python helper reading local config; hosted mode has no sync target
   * for it), and a duplicate insert (job_id already applied, PK violation,
   * Postgres code 23505) resolves to a friendly "already recorded" message
   * instead of throwing, mirroring how the local append-only helper's own
   * dedup guard degrades to a non-error outcome.
   */
  async markQueueEntryApplied(entry: QueueEntry): Promise<QueueActionResult> {
    const state = await this.loadState();
    const reg = state && registryByJobId(state.registry, entry.job_id);
    if (!reg?.job_key) {
      throw new Error(
        `Cannot mark applied: no registry record / job_key for "${entry.company} - ${entry.title}" (job_id=${entry.job_id}). Canonicalize the job first.`,
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
    const payload = {
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
      ...((entry as QueueEntry & { apply_run_id?: string }).apply_run_id ? { apply_run_id: (entry as QueueEntry & { apply_run_id?: string }).apply_run_id } : {}),
      ...(entry.screenshot_url ? { screenshot_url: entry.screenshot_url } : {}),
      ...(entry.screenshot_path ? { screenshot_path: entry.screenshot_path } : {}),
    };
    const { data: existing, error: existingError } = await this.client
      .from("applied_jobs")
      .select("status")
      .eq("user_id", this.userId)
      .eq("job_id", entry.job_id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing?.status === "needs_review") {
      const { error: updateError } = await this.client
        .from("applied_jobs")
        .update(payload)
        .eq("user_id", this.userId)
        .eq("job_id", entry.job_id);
      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await this.client.from("applied_jobs").insert(payload);
      if (insertError) {
        if (insertError.code === "23505") {
          return { message: `Already recorded: ${entry.company} - ${entry.title}` };
        }
        throw insertError;
      }
    }
    await this.recordJobEvent(reg.job_key, "applied", reasoning, entry.company, entry.title, entry.url);
    return { message: `Recorded applied: ${entry.company} - ${entry.title}` };
  }

  /**
   * Global, cross-user "how many people applied to this posting" counts:
   * public.job_apply_counts (migration 0025), maintained entirely by a
   * DB trigger on applied_jobs; this is read-only, no client can write it.
   * Batched (one request for however many job_ids a screen has on
   * screen) rather than one request per row; the same per-row-request
   * mistake the review_only worker made is easy to repeat here otherwise.
   * Missing job_ids (nobody's applied yet) simply aren't in the returned
   * map; callers should treat an absent key as 0, not as an error.
   */
  async getApplyCounts(jobIds: string[]): Promise<Record<string, number>> {
    if (jobIds.length === 0) return {};
    const { data, error } = await this.client.from("job_apply_counts").select("job_id, apply_count").in("job_id", jobIds);
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const row of (data ?? []) as Row[]) {
      const jobId = String(row.job_id ?? "");
      if (jobId) counts[jobId] = Number(row.apply_count ?? 0);
    }
    return counts;
  }

  /**
   * Logs an application aplyx never saw: applied to directly on the
   * company's own site, not through the scrape/fit-gate/apply pipeline, so
   * there's no registry row or job_key to require the way
   * markQueueEntryApplied does above. job_id is generated (a "manual:"
   * prefix keeps it visually distinct from a real scraped job_id in the
   * data, and guarantees no collision with one) purely so it can serve as
   * the row's identity for the (user_id, job_id) primary key; hosted-only
   * by design (operator's call, 2026-08-21): this exists so
   * email-tracking-worker's per-company Gmail search has something to
   * match against for an application made outside aplyx, and that worker
   * itself is already a hosted-only feature.
   */
  async addManualAppliedJob(input: { company: string; title: string; url?: string; dateApplied: string }): Promise<void> {
    const company = input.company.trim();
    const title = input.title.trim();
    if (!company || !title) throw new Error("Company and title are required.");
    const { error } = await this.client.from("applied_jobs").insert({
      user_id: this.userId,
      job_id: `manual:${crypto.randomUUID()}`,
      company,
      title,
      url: input.url?.trim() ?? "",
      date_applied: input.dateApplied,
      status: "applied",
      source: "manual",
    });
    if (error) throw error;
  }


  /**
   * Upserts one registry row (the hosted mirror of job_state.py's
   * upsert_job), called by the hosted worker (src/worker/) before every
   * fit-gate/tailor decision, exactly like the local pipeline canonicalizes
   * and registers a job before deciding its fate. Keyed on (user_id,
   * job_key): a re-run that sees the same posting again is a no-op merge,
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
   * step 10): registers the job and records the event so a future worker
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
   * needs_review, mirrors the local dual-write into data/applied_jobs.json)
   * and review_queue, so it shows up in the desktop app's Review screen.
   * review_only mode never auto-applies, so every tailored candidate lands
   * here for the user to act on manually, not just the ambiguous fit-gate
   * outcome; `reasoning` is the caller's job to make specific to which of
   * those two cases this actually is.
   *
   * Duplicate-insert tolerance (Postgres 23505) mirrors
   * markQueueEntryApplied's own dedup guard, defensive here since the
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
      fill_record: entry.fill_record,
      ...((entry as QueueEntry & { apply_run_id?: string }).apply_run_id ? { apply_run_id: (entry as QueueEntry & { apply_run_id?: string }).apply_run_id } : {}),
      ...(entry.screenshot_url ? { screenshot_url: entry.screenshot_url } : {}),
      ...(entry.screenshot_path ? { screenshot_path: entry.screenshot_path } : {}),
    };
    const { error: appliedError } = await this.client.from("applied_jobs").insert(payload);
    if (appliedError && appliedError.code !== "23505") throw appliedError;
    const { error: queueError } = await this.client.from("review_queue").insert(payload);
    if (queueError) throw queueError;
  }

  private async fetchLatestApplyRun(jobId: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("apply_runs")
      .select("*")
      .eq("user_id", this.userId)
      .eq("job_id", jobId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as Row | null) ?? undefined;
  }

  /** Ensures a (non-terminal) apply_runs row exists for this job, so
   *  the inbound-email receiver's `pendingRun` lookup (it queries
   *  apply_runs by alias_id + non-terminal status) has something to
   *  tag a verification email's apply_run_id with. Without this, a
   *  local-mode Workday continuation (which never otherwise touches
   *  apply_runs at all) leaves every inbound_emails row for its alias
   *  with apply_run_id null forever, so nothing can correlate a
   *  verification email to "this specific job" versus any other job
   *  sharing the same per-family managed alias (docs/ats-account-
   *  credentials-plan.md: "Do not match verification messages by
   *  company name alone... eligible only when its recipient, alias,
   *  tenant URL, or account correlation data matches the pending
   *  account"). Reuses an existing non-terminal run for this job
   *  rather than minting a new row on every call. */
  async ensureApplyRunForJob(jobId: string, family: AtsFamily, aliasId?: string): Promise<ApplyRunSummary> {
    const existing = await this.fetchLatestApplyRun(jobId);
    if (existing && !isTerminal(String(existing.status ?? "initialized") as ApplyRunStatus)) {
      return rowToApplyRunSummary(existing);
    }
    return this.createApplyRun({ jobId, family, aliasId });
  }

  async listManagedAliases(family?: AtsFamily): Promise<ManagedAliasRow[]> {
    let query = this.client
      .from("managed_aliases")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: true });
    if (family) query = query.eq("family", family);
    const { data, error } = await query;
    if (error) throw error;
    return ((data ?? []) as Row[]).map((row) => ({
      id: String(row.id ?? ""),
      family: String(row.family ?? "workday") as AtsFamily,
      alias: String(row.alias ?? ""),
      forwarding_to: String(row.forwarding_to ?? ""),
      status: (String(row.status ?? "active") as ManagedAliasRow["status"]),
      created_at: str(row.created_at),
      updated_at: str(row.updated_at),
    }));
  }

  async claimManagedAlias(family: AtsFamily, forwardingTo: string, preferredLocalPart?: string): Promise<ManagedAliasRow> {
    const existing = (await this.listManagedAliases(family)).find((row) => row.status === "active");
    if (existing) return existing;

    const base = normalizeAliasLocalPart(preferredLocalPart || `${this.userId.slice(0, 8)}-${family}`) || `${family}-${this.userId.slice(0, 6)}`;
    const attempts = [base, `${base}-${this.userId.slice(0, 4)}`, `${base}-${Date.now().toString(36).slice(-4)}`];
    for (const alias of attempts) {
      const { data, error } = await this.client
        .from("managed_aliases")
        .insert({ user_id: this.userId, family, alias, forwarding_to: forwardingTo })
        .select("*")
        .maybeSingle();
      if (!error && data) {
        return {
          id: String((data as Row).id ?? ""),
          family,
          alias,
          forwarding_to: forwardingTo,
          status: "active",
          created_at: str((data as Row).created_at),
          updated_at: str((data as Row).updated_at),
        };
      }
      if (error?.code !== "23505") throw error;
    }
    throw new Error(`could not claim a managed alias for ${family}`);
  }

  /** Reads inbound_emails through the ownership-checked
   *  list_own_inbound_emails RPC (migration 0031), not a direct table
   *  query: inbound_emails has RLS enabled with zero policies by
   *  design (it carries real employer email content), so a direct
   *  `.from("inbound_emails").select()` as the signed-in user's own
   *  client silently returns nothing regardless of ownership. That was
   *  a real bug: this method used to query the table directly and so
   *  always returned an empty array for a real hosted user. The RPC
   *  also redacts an expired parsed_otp/parsed_link (the plan's
   *  "expiring quickly if persistence is required"). */
  async listInboundEmails(aliasId: string): Promise<InboundEmailRow[]> {
    const { data, error } = await this.client.rpc("list_own_inbound_emails", { p_alias_id: aliasId });
    if (error) throw error;
    return ((data ?? []) as Row[]).map((row) => ({
      id: String(row.id ?? ""),
      alias_id: String(row.alias_id ?? ""),
      apply_run_id: str(row.apply_run_id),
      from_address: String(row.from_address ?? ""),
      subject: String(row.subject ?? ""),
      body_text: String(row.body_text ?? ""),
      parsed_otp: str(row.parsed_otp),
      parsed_link: str(row.parsed_link),
      classified_status: str(row.classified_status),
      forwarded_at: str(row.forwarded_at),
      consumed_at: str(row.consumed_at),
      received_at: String(row.received_at ?? ""),
    }));
  }

  /** Marks an inbound_emails row as consumed AND redacts the
   *  parsed_otp/parsed_link it carried (consume_inbound_email RPC,
   *  migration 0031): "store no OTP after successful use," not just
   *  "flag it as used while the plaintext lingers." Goes through the
   *  ownership-checked RPC for the same reason listInboundEmails does:
   *  inbound_emails has zero RLS policies, so a direct table update as
   *  the signed-in user's own client silently matches zero rows.
   *  Best-effort: a failure here is logged by the caller as a warning,
   *  not an exception: the verification mail was already used in the
   *  browser; not marking it consumed only means the next run might
   *  see it again, which the script's own checkpoint state guards
   *  against independently. */
  async consumeInboundEmail(id: string): Promise<void> {
    const { error } = await this.client.rpc("consume_inbound_email", { p_id: id });
    if (error) throw error;
  }

  // --- Workday personal-inbox verification sessions
  // (docs/workday-personal-inbox-plan.md) ---
  //
  // These mirror the migration 0038 RPCs. A session binds a user/job/apply
  // run/tenant/candidate-email/mail-connection/challenge-type with expiry
  // and attempt count; the hosted Gmail verification worker searches the
  // connected inbox within the session's window and records a matched
  // message + Vault secret. The UI polls, then consumes the one-time
  // secret ONLY after the local runtime reports it used the link/OTP.

  async createVerificationSession(input: {
    jobId: string;
    family?: AtsFamily;
    tenantKey?: string;
    company?: string;
    candidateEmail: string;
    mailConnectionId?: string;
    applyRunId?: string;
    challengeType?: "otp" | "link" | "either" | "unknown";
    expectedSenderDomains?: string[];
    expectedSubjectTokens?: string[];
    ttlMinutes?: number;
  }): Promise<string> {
    const { data, error } = await this.client.rpc("create_verification_session", {
      p_job_id: input.jobId,
      p_family: input.family ?? "workday",
      p_tenant_key: input.tenantKey ?? null,
      p_company: input.company ?? null,
      p_candidate_email: input.candidateEmail,
      p_mail_connection_id: input.mailConnectionId ?? null,
      p_apply_run_id: input.applyRunId ?? null,
      p_challenge_type: input.challengeType ?? "either",
      p_expected_sender_domains: input.expectedSenderDomains ?? [],
      p_expected_subject_tokens: input.expectedSubjectTokens ?? [],
      p_ttl_minutes: input.ttlMinutes ?? 30,
    });
    if (error) throw error;
    return String(data);
  }

  async getVerificationSession(sessionId: string): Promise<VerificationSessionDetail | undefined> {
    const { data, error } = await this.client.rpc("get_own_verification_session", { p_session_id: sessionId });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id ?? ""),
      job_id: String(row.job_id ?? ""),
      family: String(row.family ?? "workday") as AtsFamily,
      tenant_key: str(row.tenant_key),
      company: str(row.company),
      candidate_email: String(row.candidate_email ?? ""),
      mail_connection_id: str(row.mail_connection_id),
      apply_run_id: str(row.apply_run_id),
      status: String(row.status ?? "created") as VerificationSessionRow["status"],
      challenge_type: String(row.challenge_type ?? "unknown") as VerificationSessionRow["challenge_type"],
      expected_sender_domains: strArray(row.expected_sender_domains) ?? [],
      expected_subject_tokens: strArray(row.expected_subject_tokens) ?? [],
      expires_at: str(row.expires_at),
      attempt_count: num(row.attempt_count) ?? 0,
      last_poll_at: str(row.last_poll_at),
      resolved_at: str(row.resolved_at),
      failure_reason: str(row.failure_reason),
      has_secret: bool(row.has_secret) ?? false,
      message_extracted_kind: str(row.message_extracted_kind) as "otp" | "link" | "unknown" | undefined,
      created_at: str(row.created_at),
      updated_at: str(row.updated_at),
    };
  }

  async pollVerificationSession(sessionId: string): Promise<VerificationSessionPoll | undefined> {
    const { data, error } = await this.client.rpc("poll_own_verification_session", { p_session_id: sessionId });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
    if (!row) return undefined;
    return {
      status: String(row.status ?? "created") as VerificationSessionRow["status"],
      has_secret: bool(row.has_secret) ?? false,
      message_extracted_kind: str(row.message_extracted_kind) as "otp" | "link" | "unknown" | undefined,
      attempt_count: num(row.attempt_count) ?? 0,
      expires_at: str(row.expires_at),
      failure_reason: str(row.failure_reason),
    };
  }

  /** REVEAL (pre-runtime): returns the raw OTP/link for the session's
   *  latest unconsumed message WITHOUT consuming it, so the caller can
   *  write it to a 0600 temp file for the runtime. The secret remains
   *  available for retry if the runtime fails to use it. Stamps a soft
   *  lease (leased_at) server-side. */
  async revealVerificationSecret(sessionId: string): Promise<{ extractedKind?: string; secretValue?: string; messageId?: string } | undefined> {
    const { data, error } = await this.client.rpc("reveal_verification_secret", { p_session_id: sessionId });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
    if (!row) return undefined;
    return {
      extractedKind: str(row.extracted_kind),
      secretValue: str(row.secret_value),
      messageId: str(row.message_id),
    };
  }

  /** CONFIRM CONSUME (post-runtime): redacts the secret and deletes the
   *  underlying Vault secret. Call this ONLY after the local runtime
   *  reports used_verification_link/used_verification_otp, never before.
   *  Returns void; the secret value was already revealed via
   *  revealVerificationSecret. A second call is a no-op. */
  async consumeVerificationSecret(sessionId: string): Promise<void> {
    const { error } = await this.client.rpc("consume_verification_secret", { p_session_id: sessionId });
    if (error) throw error;
  }

  async createApplyRun(input: CreateApplyRunInput): Promise<ApplyRunSummary> {
    const status = input.status ?? "initialized";
    const { data, error } = await this.client
      .from("apply_runs")
      .insert({
        user_id: this.userId,
        job_id: input.jobId,
        family: input.family,
        status,
        alias_id: input.aliasId,
        account_id: input.accountId,
        tailored_resume_attached: input.tailoredResumeAttached ?? false,
        tailored_resume_artifact_path: input.tailoredResumeArtifactPath,
        fill_plan: input.fillPlan ?? null,
        checkpoint: input.checkpoint ?? null,
        approval_state: input.approvalState ?? "pending",
        screenshot_url: input.screenshotUrl,
        started_at: new Date().toISOString(),
      })
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return rowToApplyRunSummary((data ?? {}) as Row);
  }

  /** Create-or-reuse the ATS account an account-required family's apply
   *  run needs (docs/ats-account-credentials-plan.md Package 3). Thin
   *  wrapper over the create_application_account RPC (migration 0028):
   *  all the actual idempotency (same user+family+tenant+login reuses
   *  the existing account rather than minting a second Vault secret)
   *  lives server-side in that RPC, not here. Returns only the account
   *  id; the username/password just submitted are never returned or
   *  logged; they were only ever in memory to pass to Vault. */
  async createOrReuseApplicationAccount(input: CreateOrReuseApplicationAccountInput): Promise<{ accountId: string }> {
    const { data, error } = await this.client.rpc("create_application_account", {
      p_ats_family: input.family,
      p_tenant_key: input.tenantKey,
      p_company_name: input.companyName,
      p_username: input.username,
      p_password: input.password,
      p_managed_alias_id: input.managedAliasId ?? null,
    });
    if (error) throw error;
    return { accountId: String(data) };
  }

  /** Attach (or clear) an apply run's ATS account outside the status
   *  state machine. Account creation and final submission are separate
   *  state transitions (Package 3 acceptance criterion): linking an
   *  account to a run is metadata, not a lifecycle move, so this never
   *  calls applyStateMachine.ts's transition() the way
   *  updateApplyRunStatus does. Safe to call at any point in a run's
   *  life, including before the account itself reaches 'active'. */
  async linkApplyRunAccount(runId: string, accountId: string | null): Promise<ApplyRunSummary> {
    const { data, error } = await this.client
      .from("apply_runs")
      .update({ account_id: accountId })
      .eq("id", runId)
      .eq("user_id", this.userId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`apply run ${runId} not found`);
    return rowToApplyRunSummary(data as Row);
  }

  // --- Package 6: user account center (docs/ats-account-credentials-plan.md) ---

  /** Masked metadata only: get_application_account_metadata (migration
   *  0028) never returns credential_secret_id, and this row shape has
   *  no username/password field at all, so there is no way for this
   *  method to leak a credential even by accident. */
  async listApplicationAccounts(): Promise<ApplicationAccountRow[]> {
    const { data, error } = await this.client.rpc("get_application_account_metadata");
    if (error) throw error;
    return ((data ?? []) as Row[]).map((row) => ({
      id: String(row.id ?? ""),
      company_name: String(row.company_name ?? ""),
      ats_family: String(row.ats_family ?? "") as AtsFamily,
      tenant_key: String(row.tenant_key ?? ""),
      login_hint: str(row.login_hint),
      status: String(row.status ?? ""),
      verification_status: String(row.verification_status ?? ""),
      status_tracking_enabled: bool(row.status_tracking_enabled) ?? false,
      last_login_at: str(row.last_login_at),
      last_status_check_at: str(row.last_status_check_at),
    }));
  }

  /** Reveals the caller's own username/password for one account
   *  (reveal_own_account_credential RPC: authenticated-only,
   *  ownership-checked server-side, logs a login_succeeded/reveal
   *  event on every call). The caller is responsible for gating this
   *  behind recent re-authentication before calling it; the plan's
   *  own comment on the RPC notes that timing is enforced at the
   *  client/session layer, not inside the SQL function. */
  async revealApplicationAccountCredential(accountId: string): Promise<{ username: string; password: string }> {
    const { data, error } = await this.client.rpc("reveal_own_account_credential", { p_account_id: accountId });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
    return { username: String(row?.username ?? ""), password: String(row?.password ?? "") };
  }

  /** Overwrites the stored credential with a new username/password
   *  (rotate_application_account_secret RPC): e.g. after the user
   *  resets their password directly on the ATS site. */
  async rotateApplicationAccountSecret(accountId: string, newUsername: string, newPassword: string): Promise<void> {
    const { error } = await this.client.rpc("rotate_application_account_secret", {
      p_account_id: accountId,
      p_new_username: newUsername,
      p_new_password: newPassword,
    });
    if (error) throw error;
  }

  /** status_tracking_enabled is a plain column with its own RLS
   *  update-own policy (migration 0027): no RPC needed for this one
   *  field, unlike the credential-touching operations above. */
  async setApplicationAccountStatusTracking(accountId: string, enabled: boolean): Promise<void> {
    const { error } = await this.client
      .from("application_accounts")
      .update({ status_tracking_enabled: enabled })
      .eq("id", accountId)
      .eq("user_id", this.userId);
    if (error) throw error;
  }

  /** Tombstones the Vault secret and soft-deletes the account
   *  (delete_application_account RPC, authenticated-only). */
  async deleteApplicationAccount(accountId: string): Promise<void> {
    const { error } = await this.client.rpc("delete_application_account", { p_account_id: accountId });
    if (error) throw error;
  }

  async updateApplyRunStatus(
    runId: string,
    nextStatus: ApplyRunStatus,
    extras: Partial<{
      checkpoint: unknown;
      fillPlan: unknown;
      approvalState: "pending" | "approved" | "rejected";
      screenshotUrl: string;
      tailoredResumeArtifactPath: string;
      error: string | null;
      tailoredResumeAttached: boolean;
      finishedAt: string | null;
    }> = {},
  ): Promise<ApplyRunSummary> {
    const { data: current, error: currentError } = await this.client
      .from("apply_runs")
      .select("*")
      .eq("id", runId)
      .eq("user_id", this.userId)
      .maybeSingle();
    if (currentError) throw currentError;
    if (!current) throw new Error(`apply run ${runId} not found`);
    const status = transition(String((current as Row).status ?? "initialized") as ApplyRunStatus, nextStatus);
    const { data, error } = await this.client
      .from("apply_runs")
      .update({
        status,
        checkpoint: extras.checkpoint,
        fill_plan: extras.fillPlan,
        approval_state: extras.approvalState,
        screenshot_url: extras.screenshotUrl,
        tailored_resume_artifact_path: extras.tailoredResumeArtifactPath,
        tailored_resume_attached: extras.tailoredResumeAttached,
        error: extras.error,
        finished_at: extras.finishedAt,
      })
      .eq("id", runId)
      .eq("user_id", this.userId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return rowToApplyRunSummary((data ?? {}) as Row);
  }

  async saveReadyToSubmit(
    record: { job_key: string; job_id: string; company: string; title: string; url: string; internship_term?: string },
    entry: QueueEntry,
    options: SaveReadyToSubmitOptions,
  ): Promise<ApplyRunSummary> {
    await this.registerJob(record);
    await this.recordJobEvent(record.job_key, "needs_review", entry.reasoning ?? "Awaiting submit approval", record.company, record.title, record.url);
    const run = await this.createApplyRun({
      jobId: entry.job_id,
      family: options.family,
      aliasId: options.aliasId,
      accountId: options.accountId,
      tailoredResumeAttached: Boolean(options.tailoredResumeArtifactPath),
      tailoredResumeArtifactPath: options.tailoredResumeArtifactPath,
      fillPlan: options.fillPlan,
      checkpoint: options.checkpoint,
      screenshotUrl: options.screenshotUrl,
      status: "confirm_before_submit",
      approvalState: "pending",
    });
    const appliedPayload = {
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
      fill_record: options.fillRecord,
      apply_run_id: run.runId,
      screenshot_url: options.screenshotUrl,
    };
    const queuePayload = {
      ...appliedPayload,
      status: "ready_to_submit",
    };
    const { error: appliedError } = await this.client.from("applied_jobs").insert(appliedPayload);
    if (appliedError && appliedError.code !== "23505") throw appliedError;
    const { error: queueError } = await this.client.from("review_queue").insert(queuePayload);
    if (queueError) throw queueError;
    return run;
  }

  async approveSubmit(entry: QueueEntry): Promise<{ ok: boolean; message: string }> {
    const current = await this.fetchLatestApplyRun(entry.job_id);
    if (!current) {
      return { ok: false, message: `No apply run found for ${entry.company} - ${entry.title}.` };
    }
    const status = String(current.status ?? "initialized") as ApplyRunStatus;
    if (status !== "confirm_before_submit" && status !== "ready_to_submit") {
      return { ok: false, message: `Cannot approve submit from apply-run status '${status}'.` };
    }
    const family = str((current as Row).family) ?? (entry.source ?? "");
    // Hosted browser execution does not exist for ANY family yet: there
    // is no hosted Playwright worker that can drive a real submit. The
    // message is family-specific so a Workday user (who needs account
    // creation + verification mail handling, which only the local runtime
    // does) isn't told to "use the local Greenhouse path" the way an
    // earlier generic version of this message implied. This is the honest
    // failure path: the apply run stays paused at confirm-before-submit,
    // and the user is told exactly what doesn't exist and what to do
    // instead. Never pretend hosted execution succeeded.
    if (family === "workday") {
      return {
        ok: false,
        message:
          "Hosted Workday browser execution isn't available. Workday applications need a local aplyx install to drive account creation and verification-mail handling. Open the job URL and apply manually, or set up a local install and use Continue Workday from its Review screen.",
      };
    }
    return {
      ok: false,
      message:
        "Hosted approve-submit is not implemented yet. The apply run remains paused at confirm-before-submit; use a local aplyx install to drive the submit, or apply manually via the job URL.",
    };
  }

  /** Hosted mirror of reviewActions.ts's dismissQueueEntry: same
   *  never-throws contract (every failure mode comes back as a displayable
   *  message, not an exception), same guard order. */
  async dismissQueueEntry(entry: QueueEntry): Promise<QueueActionResult> {
    const state = await this.loadState();
    if (state && hasAppliedOrFailed(state, entry)) {
      return {
        message: `Cannot dismiss: "${entry.company} - ${entry.title}" already has an applied/failed outcome; dismiss would overwrite it with skipped_unfit.`,
      };
    }
    if (state && isDismissed(state, entry)) {
      return { message: `Already dismissed: "${entry.company} - ${entry.title}" is already marked skipped_unfit.` };
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
    return { message: `Dismissed: ${entry.company} - ${entry.title}` };
  }
}

export interface QueueActionResult {
  message: string;
}
