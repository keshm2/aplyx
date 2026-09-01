/**
 * Hosted review_only worker: Phase 17 first increment.
 *
 * Claims queued `hosted_runs` rows (mode='review_only' only; auto_apply
 * rows are never selected, enforced in the claim query below, not just by
 * convention) and runs, per row: fetch -> canonicalize -> fit-gate ->
 * tailor -> land in review_queue, for one signed-in hosted user.
 *
 * Invocation mirrors refreshJobCache.js (see .github/workflows/
 * hosted-worker.yml): `node src/worker/dist/run.js`, run from the repo
 * root, holding SUPABASE_SECRET_KEY (service-role: bypasses RLS,
 * required to act on behalf of every user, not just one signed-in
 * session) and ANTHROPIC_API_KEY as env vars only, never a config file.
 *
 * Concurrency: this workflow's own GitHub Actions concurrency group (like
 * refresh-job-cache.yml's) guarantees only one worker process runs at a
 * time, so the claim query below only needs a conditional UPDATE ... WHERE
 * status='queued' to prevent a double-claim, not a Postgres FOR UPDATE
 * SKIP LOCKED RPC function, which PostgREST can't express directly and
 * which single-worker concurrency doesn't need.
 *
 * Fetch sources this increment: Ashby, Lever, Greenhouse, Workable, the
 * four sources whose list response already carries full jd_text with zero
 * extra per-job network calls (see jobs.ts's fetchAshby/fetchLever/
 * fetchGreenhouse/fetchWorkable). SmartRecruiters/Amazon/Oracle/Workday/
 * JazzHR are deliberately NOT fetched here: SmartRecruiters needs a
 * per-job detail fetch before jd_text exists at all (jobs.ts's
 * checkJobFit), Amazon/Oracle/Workday/Muse's Python fetchers read
 * src/config/targets.json relative to cwd (would either collide with an
 * operator's own local dev config or require duplicating the repo
 * checkout into every scratch dir), and JazzHR has no exported TS fetch
 * function at all. All are reasonable, cheap follow-ups once this first
 * increment is proven; not silently dropped, just out of scope for now.
 *
 * Company slugs come from the same committed, non-PII pool
 * refreshJobCache.ts already refreshes daily (src/config/
 * job_cache_targets.json + src/config/workable_vetted_slugs.json); hosted
 * onboarding doesn't collect per-user company slugs today (see the
 * approved plan's "Explicitly out of scope"), so personalization happens
 * at the fit-gate/tailor stage (per-user role_keywords, resume, JD
 * matching), not at the fetch-source stage.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { findProjectRoot } from "@aplyx/core/project.js";
import { readSupabaseConfig } from "@aplyx/core/supabaseConfig.js";
import { fetchAshby, fetchLever, fetchGreenhouse, fetchWorkable } from "@aplyx/core/jobs.js";
import { dedupeKey, type SearchJob } from "@aplyx/core/jobsSort.js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { HOSTED_PROFILE_FIELD_IDS, HOSTED_PREFERENCE_FIELD_IDS } from "@aplyx/core/onboarding/hostedFields.js";
import type { QueueEntry } from "@aplyx/core/stateDerive.js";

const execFileAsync = promisify(execFile);

// Bounds one run's wall-clock cost so a single stuck fetch/tailor call
// can't hang the whole scheduled job: mirrors refresh-job-cache.yml's
// own timeout-minutes safety cap. 20 minutes leaves real margin under the
// 30-minute GitHub Actions job timeout this ships with.
const RUN_BUDGET_MS = 20 * 60 * 1000;
// Same session-cap spirit as CLAUDE.md's local "max 25 per session" rule
// (there for applications submitted; here for jobs tailored/queued): a
// deliberate, bounded amount of Anthropic spend and desktop-review-queue
// growth per run, not a cost-tuned number yet.
const MAX_TAILORED_PER_RUN = 25;
// job-scraper.md Phase 2 step 3's own cutoff: below this, no cover letter
// is generated and the job still lands in review_queue as needs_review
// context for the human, not silently dropped.
const ATS_SCORE_CUTOFF = 60;

interface HostedRunRow {
  id: string;
  user_id: string;
  status: string;
  mode: string;
  result: unknown;
}

interface ClaimedRun extends HostedRunRow {
  startedAtMs: number;
}

interface ScratchTargets {
  role_keywords: string[];
  level_keywords: string[];
  season_keywords: string[];
  preferred_locations: string[];
  fallback_scope: string;
  allow_experienced_roles: boolean;
  graduation_date: string;
}

interface RunCounts {
  jobs_fetched: number;
  jobs_new: number;
  skipped_unfit: number;
  needs_review: number;
  tailored_high_score: number;
  tailored_low_score: number;
  errors: number;
}

function newCounts(): RunCounts {
  return { jobs_fetched: 0, jobs_new: 0, skipped_unfit: 0, needs_review: 0, tailored_high_score: 0, tailored_low_score: 0, errors: 0 };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

/** Every script this worker shells out to prints one JSON object to
 *  stdout on BOTH its success and its own handled-failure paths (see
 *  tailor_resume_hosted.py/tailor_cover_letter_hosted.py's {"ok": false,
 *  "error": ...} contract, and evaluate_job_fit.py's `error()` helper):
 *  only a genuinely unhandled crash (job_state.py's die(), a Python
 *  traceback, a timeout) has nothing usable on stdout. Node's execFile
 *  rejects on ANY nonzero exit code regardless of which of those actually
 *  happened, so a script that behaved exactly as documented (a clean,
 *  JSON-reported "tailoring failed") would otherwise look identical to a
 *  hard crash to this worker, and previously WAS silently swallowed:
 *  caught by the per-job catch block, counted as an error, and never
 *  written to review_queue or marked seen, so the same job would be
 *  re-fetched and re-attempted forever. Preferring stdout whenever it
 *  parses as JSON, regardless of exit code, restores the scripts' own
 *  documented contract; only a genuinely empty/non-JSON stdout still
 *  propagates as a real thrown error. */
async function runPython(root: string, scriptRelPath: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  const scriptPath = path.join(root, scriptRelPath);
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 90_000,
      env: { ...process.env, ...extraEnv },
    });
    return stdout;
  } catch (err) {
    const stdout = (err as { stdout?: string })?.stdout;
    if (stdout) {
      try {
        JSON.parse(stdout);
        return stdout;
      } catch {
        // stdout wasn't valid JSON either; fall through to rethrow below.
      }
    }
    throw err;
  }
}

/** Same nonzero-exit-tolerant JSON handling as runPython, but feeds a
 *  potentially large payload over stdin ('-') instead of argv: required
 *  for the batch subcommands below: a real run's fetched-postings array
 *  (JD text included) is tens of megabytes, far past any OS's command-
 *  line argument length limit. Node's execFile has no `input` option on
 *  its async form, but util.promisify attaches the live ChildProcess to
 *  the returned promise as `.child` (documented Node behavior); write
 *  to its stdin directly instead of going through execFileAsync's own
 *  options object, which only `execFileSync` supports. */
async function runPythonStdin(root: string, scriptRelPath: string, args: string[], stdinData: string): Promise<string> {
  const scriptPath = path.join(root, scriptRelPath);
  const call = execFileAsync("python3", [scriptPath, ...args], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: 120_000,
    env: process.env,
  }) as Promise<{ stdout: string }> & { child: import("node:child_process").ChildProcess };
  call.child.stdin!.end(stdinData);
  try {
    const { stdout } = await call;
    return stdout;
  } catch (err) {
    const stdout = (err as { stdout?: string })?.stdout;
    if (stdout) {
      try {
        // Batch output is JSONL, not a single JSON value: validate line
        // by line rather than JSON.parse-ing the whole blob.
        for (const line of stdout.split("\n")) {
          if (line.trim()) JSON.parse(line);
        }
        return stdout;
      } catch {
        // fall through to rethrow below
      }
    }
    throw err;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// 500 postings/chunk: keeps each subprocess call's stdin payload (full JD
// text included) in the low single-digit megabytes and each call's own
// runtime short, while still cutting a 16,593-job run from that many
// process spawns down to ~34: the actual fix for the wall-clock-budget
// exhaustion confirmed live during this increment's first verification
// run (per-spawn interpreter startup, not the deterministic logic itself,
// was the dominant cost).
const CANONICALIZE_CHUNK_SIZE = 500;

/** Canonicalizes every fetched posting via job_state.py's canonicalize-
 *  batch subcommand, chunked, instead of one `python3` spawn per job. */
async function canonicalizeBatch(root: string, raws: SearchJob[]): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const part of chunk(raws, CANONICALIZE_CHUNK_SIZE)) {
    const stdout = await runPythonStdin(root, "src/scripts/state/job_state.py", ["canonicalize-batch", "-"], JSON.stringify(part));
    for (const line of stdout.split("\n")) {
      if (line.trim()) results.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return results;
}

interface FitResult {
  ok: boolean;
  fit_status: "candidate" | "needs_review" | "skipped_unfit";
  reasoning: string;
  matched_level_keyword: string;
}

/** evaluate_job_fit.py --batch, chunked the same way as canonicalizeBatch:
 *  same 1:1 input-order-preserved-output contract, confirmed by both
 *  scripts' own batch loops (a plain for-loop over the input array,
 *  printing one result per line in order, never reordering/deduping). */
async function evaluateFitBatch(root: string, canonicals: Record<string, unknown>[], targetsPath: string): Promise<FitResult[]> {
  const results: FitResult[] = [];
  for (const part of chunk(canonicals, CANONICALIZE_CHUNK_SIZE)) {
    const stdout = await runPythonStdin(root, "src/scripts/jobs/evaluate_job_fit.py", ["-", "--batch", "--targets", targetsPath], JSON.stringify(part));
    for (const line of stdout.split("\n")) {
      if (line.trim()) results.push(JSON.parse(line) as FitResult);
    }
  }
  return results;
}

interface TailorResumeResult {
  ok: boolean;
  error?: string;
  resume_used?: string;
  tailored_bullets?: string[];
  ats_score?: number;
  missing_keywords?: string[];
}

async function tailorResume(root: string, payload: { title: string; jd_text: string; resume_markdown: string }): Promise<TailorResumeResult> {
  const stdout = await runPython(root, "src/scripts/runtime/tailor_resume_hosted.py", [JSON.stringify(payload)], { APLYX_ROOT: root });
  return JSON.parse(stdout) as TailorResumeResult;
}

interface TailorCoverLetterResult {
  ok: boolean;
  error?: string;
  cover_letter?: string;
}

async function tailorCoverLetter(root: string, payload: { company: string; title: string; jd_text: string; tailored_bullets: string[] }): Promise<TailorCoverLetterResult> {
  const stdout = await runPython(root, "src/scripts/runtime/tailor_cover_letter_hosted.py", [JSON.stringify(payload)], { APLYX_ROOT: root });
  return JSON.parse(stdout) as TailorCoverLetterResult;
}

/** "internship" if the fit gate's matched level keyword reads as one,
 *  else "new_grad": a deterministic stand-in for the judgment call
 *  job-scraper.md's own roleType() heuristic (jobs.ts) makes locally,
 *  reused here nearly verbatim rather than inventing a new rule. */
function roleTypeFromLevelKeyword(matched: string): "internship" | "new_grad" {
  const value = matched.toLowerCase();
  const newGradTerms = ["new grad", "new graduate", "entry level", "entry-level", "associate", "junior", "early career", "university grad", "campus"];
  return newGradTerms.some((term) => value.includes(term)) ? "new_grad" : "internship";
}

function locationTierFor(location: string | undefined, preferredLocations: string[]): "preferred" | "fallback" {
  if (!location || preferredLocations.length === 0) return "fallback";
  const loc = location.toLowerCase();
  return preferredLocations.some((pref) => pref.trim() && loc.includes(pref.trim().toLowerCase())) ? "preferred" : "fallback";
}

async function fetchCandidateJobs(root: string): Promise<SearchJob[]> {
  const jobCacheTargets = await readJsonFile<{ ashby_company_slugs?: string[]; lever_company_slugs?: string[]; greenhouse_company_slugs?: string[] }>(
    path.join(root, "src", "config", "job_cache_targets.json"),
  );
  const workableVetted = await readJsonFile<{ slugs?: string[] }>(path.join(root, "src", "config", "workable_vetted_slugs.json"));

  const [ashby, lever, greenhouse, workable] = await Promise.all([
    fetchAshby(jobCacheTargets.ashby_company_slugs ?? []),
    fetchLever(jobCacheTargets.lever_company_slugs ?? []),
    fetchGreenhouse(jobCacheTargets.greenhouse_company_slugs ?? []),
    fetchWorkable(workableVetted.slugs ?? []),
  ]);

  const seen = new Set<string>();
  const deduped: SearchJob[] = [];
  for (const job of [...ashby.jobs, ...lever.jobs, ...greenhouse.jobs, ...workable.jobs]) {
    const key = dedupeKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }
  return deduped;
}

/** Downloads the signed-in user's one uploaded resume PDF from Supabase
 *  Storage (bucket "resumes", path "<userId>/<filename>", see
 *  ResumeUploadStep.tsx) and converts it to markdown via the unmodified
 *  convert_resume.py, in the run's own scratch dir so nothing here ever
 *  touches an operator's local data/resumes/. Picks the most-recently-
 *  updated object under the user's folder if more than one exists (the
 *  upload step re-uses upsert:true for a re-upload of the SAME filename,
 *  but a differently-named re-upload creates a second object). */
async function downloadResumeMarkdown(adminClient: SupabaseClient, root: string, scratchDir: string, userId: string): Promise<string> {
  const { data: entries, error: listError } = await adminClient.storage.from("resumes").list(userId);
  if (listError) throw listError;
  const files = (entries ?? []).filter((e) => e.name && !e.name.startsWith("."));
  if (files.length === 0) {
    throw new Error("no resume uploaded for this account");
  }
  files.sort((a, b) => new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime());
  const chosen = files[0]!;
  const { data: blob, error: downloadError } = await adminClient.storage.from("resumes").download(`${userId}/${chosen.name}`);
  if (downloadError) throw downloadError;
  const buffer = Buffer.from(await blob.arrayBuffer());
  const pdfPath = path.join(scratchDir, "resume.pdf");
  await fs.writeFile(pdfPath, buffer);
  await runPython(root, "src/scripts/state/convert_resume.py", ["resume", "--resumes-dir", scratchDir]);
  return fs.readFile(path.join(scratchDir, "resume.md"), "utf8");
}

async function buildScratchTargets(root: string, preferences: Record<string, string[]>, profile: Record<string, string>): Promise<ScratchTargets> {
  const example = await readJsonFile<{ level_keywords: string[]; season_keywords: string[]; fallback_scope: string; role_keywords: string[] }>(
    path.join(root, "src", "config", "targets.example.json"),
  );
  const roleKeywords = preferences.role_keywords && preferences.role_keywords.length > 0 ? preferences.role_keywords : example.role_keywords;
  return {
    role_keywords: roleKeywords,
    level_keywords: example.level_keywords,
    season_keywords: example.season_keywords,
    preferred_locations: preferences.preferred_locations ?? [],
    fallback_scope: example.fallback_scope,
    allow_experienced_roles: false,
    graduation_date: profile.graduation_date || "",
  };
}

/** Claims the oldest queued, review_only hosted_runs row. Checks a
 *  handful of candidates in created_at order rather than exactly one, so
 *  a lost race on the conditional UPDATE (only possible if two worker
 *  processes somehow overlap despite the workflow's own concurrency
 *  group) falls through to the next-oldest row instead of returning
 *  nothing. mode='review_only' is a hard filter here, not a default;
 *  this is what actually keeps an auto_apply row untouched, independent
 *  of the migration's own check constraint. */
async function claimNextReviewOnlyRun(adminClient: SupabaseClient): Promise<HostedRunRow | null> {
  const { data: candidates, error } = await adminClient
    .from("hosted_runs")
    .select("id, user_id, status, mode, result")
    .eq("status", "queued")
    .eq("mode", "review_only")
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw error;
  const now = new Date().toISOString();
  for (const candidate of (candidates ?? []) as HostedRunRow[]) {
    const { data: claimed, error: claimError } = await adminClient
      .from("hosted_runs")
      .update({ status: "running", claimed_at: now, started_at: now })
      .eq("id", candidate.id)
      .eq("status", "queued")
      .select("id, user_id, status, mode, result")
      .maybeSingle();
    if (claimError) throw claimError;
    if (claimed) return claimed as HostedRunRow;
  }
  return null;
}

async function finishRun(adminClient: SupabaseClient, runId: string, status: "succeeded" | "failed", result: RunCounts | undefined, error: string | undefined): Promise<void> {
  const { error: updateError } = await adminClient
    .from("hosted_runs")
    .update({ status, finished_at: new Date().toISOString(), result: result ?? null, error: error ?? null })
    .eq("id", runId);
  if (updateError) throw updateError;
}

async function processRun(adminClient: SupabaseClient, root: string, run: ClaimedRun): Promise<void> {
  const counts = newCounts();
  let scratchDir: string | undefined;
  try {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), `hosted-run-${run.id}-`));
    const adapter = new SupabaseAdapter(adminClient, run.user_id);

    const profileEntries = await Promise.all(HOSTED_PROFILE_FIELD_IDS.map(async (id) => [id, await adapter.readProfileField(id)] as const));
    const profile: Record<string, string> = {};
    for (const [id, value] of profileEntries) profile[id] = Array.isArray(value) ? value.join(", ") : value;

    const preferenceEntries = await Promise.all(HOSTED_PREFERENCE_FIELD_IDS.map(async (id) => [id, await adapter.readProfileField(id)] as const));
    const preferences: Record<string, string[]> = {};
    for (const [id, value] of preferenceEntries) preferences[id] = Array.isArray(value) ? value : value ? [value] : [];

    const resumeMarkdown = await downloadResumeMarkdown(adminClient, root, scratchDir, run.user_id);

    const targets = await buildScratchTargets(root, preferences, profile);
    const targetsPath = path.join(scratchDir, "targets.json");
    await fs.writeFile(targetsPath, JSON.stringify(targets, null, 2));

    const existingState = await adapter.loadState();
    const knownJobKeys = new Set((existingState?.registry ?? []).map((r) => r.job_key));

    const fetched = await fetchCandidateJobs(root);
    counts.jobs_fetched = fetched.length;

    // Batched, not one process per job: see canonicalizeBatch's own
    // comment for why (a 16,593-job live run spent its entire 20-minute
    // budget on per-job interpreter startup alone before this fix).
    const canonicals = await canonicalizeBatch(root, fetched);
    if (canonicals.length !== fetched.length) {
      // Every SearchJob this worker's fetchers produce already has
      // non-empty source/company/title (each fetch function filters out
      // anything missing title/url before returning; see fetchAshby et
      // al.), so canonicalize-batch's own per-item skip path should never
      // actually trigger here. If it somehow does, refuse to proceed
      // rather than silently pairing the wrong canonical record with the
      // wrong raw job further down.
      throw new Error(`canonicalize-batch returned ${canonicals.length} result(s) for ${fetched.length} input(s): refusing to proceed with a misaligned batch`);
    }

    // Dedup against both the DB's existing registry AND duplicates within
    // this run's own fetch (two raw postings that canonicalize to the same
    // job_key, e.g. the same real posting reachable two ways), the
    // per-job loop below used to do this check as it went; doing it once,
    // up front, is what lets fit-gating skip work it doesn't need to do.
    const seenJobKeys = new Set(knownJobKeys);
    const newCanonicals: Record<string, unknown>[] = [];
    for (const canonical of canonicals) {
      const jobKey = String(canonical.job_key ?? "");
      if (!jobKey || seenJobKeys.has(jobKey)) continue;
      seenJobKeys.add(jobKey);
      newCanonicals.push(canonical);
    }
    counts.jobs_new = newCanonicals.length;

    const fitResults = await evaluateFitBatch(root, newCanonicals, targetsPath);
    if (fitResults.length !== newCanonicals.length) {
      throw new Error(`evaluate_job_fit.py --batch returned ${fitResults.length} result(s) for ${newCanonicals.length} input(s): refusing to proceed with a misaligned batch`);
    }

    let tailoredThisRun = 0;
    for (let i = 0; i < newCanonicals.length; i++) {
      if (Date.now() - run.startedAtMs > RUN_BUDGET_MS) break;
      if (tailoredThisRun >= MAX_TAILORED_PER_RUN) break;
      const canonical = newCanonicals[i]!;
      const fit = fitResults[i]!;
      const jobKey = String(canonical.job_key ?? "");
      try {
        const registryRecord = {
          job_key: jobKey,
          job_id: String(canonical.job_id ?? ""),
          company: String(canonical.company ?? ""),
          title: String(canonical.title ?? ""),
          url: String(canonical.url ?? ""),
          internship_term: canonical.internship_term ? String(canonical.internship_term) : undefined,
        };

        if (!["candidate", "needs_review", "skipped_unfit"].includes(fit.fit_status)) {
          // evaluate_job_fit.py's own error() path also prints JSON+exits
          // nonzero (e.g. a malformed scratch targets.json): runPython
          // already surfaces that JSON instead of throwing, but its shape
          // has no fit_status at all. Route to review rather than falling
          // through into the tailoring branch with an undefined status.
          throw new Error(`evaluate_job_fit.py did not return a usable fit_status: ${JSON.stringify(fit)}`);
        }
        if (fit.fit_status === "skipped_unfit") {
          await adapter.recordSkippedUnfit(registryRecord, fit.reasoning);
          counts.skipped_unfit++;
          continue;
        }

        const roleType = roleTypeFromLevelKeyword(fit.matched_level_keyword || "");
        const locationTier = locationTierFor(String(canonical.location ?? ""), targets.preferred_locations);
        const jdText = String(canonical.jd_text ?? "");
        const baseEntry: QueueEntry = {
          job_id: registryRecord.job_id,
          company: registryRecord.company,
          title: registryRecord.title,
          url: registryRecord.url,
          apply_url: canonical.apply_url ? String(canonical.apply_url) : undefined,
          date_applied: new Date().toISOString().slice(0, 10),
          status: "needs_review",
          role_type: roleType,
          source: String(canonical.source ?? ""),
          resume_used: "hosted",
          ats_score: 0,
          location_tier: locationTier,
          cover_letter_used: false,
          reasoning: fit.reasoning,
        };

        if (fit.fit_status === "needs_review") {
          await adapter.saveJobForReview(registryRecord, baseEntry, fit.reasoning);
          counts.needs_review++;
          continue;
        }

        // fit.fit_status === "candidate": tailor.
        if (!jdText) {
          // AGENTS.md: never fit-gate/tailor a job with empty jd_text. A
          // candidate-status job should always have one from these four
          // sources, but if it somehow doesn't, route to needs_review
          // rather than tailoring against nothing.
          await adapter.saveJobForReview(registryRecord, baseEntry, "candidate fit but jd_text is empty: routed to review instead of tailoring blind");
          counts.needs_review++;
          continue;
        }

        const resumeResult = await tailorResume(root, { title: registryRecord.title, jd_text: jdText, resume_markdown: resumeMarkdown });
        if (!resumeResult.ok || !resumeResult.tailored_bullets || typeof resumeResult.ats_score !== "number") {
          await adapter.saveJobForReview(registryRecord, baseEntry, `tailoring failed: ${resumeResult.error ?? "unknown error"}`);
          counts.needs_review++;
          counts.errors++;
          continue;
        }
        tailoredThisRun++;

        const tailoredEntry: QueueEntry = {
          ...baseEntry,
          resume_used: resumeResult.resume_used ?? "hosted",
          ats_score: resumeResult.ats_score,
          tailored_bullets: resumeResult.tailored_bullets,
          missing_keywords: resumeResult.missing_keywords ?? [],
        };

        if (resumeResult.ats_score < ATS_SCORE_CUTOFF) {
          // job-scraper.md Phase 2 step 3: below cutoff, no cover letter,
          // still lands in review_queue with the tailored context.
          await adapter.saveJobForReview(registryRecord, tailoredEntry, `Tailored but ats_score ${resumeResult.ats_score} is below the ${ATS_SCORE_CUTOFF} cutoff: reviewed, not a strong match.`);
          counts.tailored_low_score++;
          continue;
        }

        const coverLetterResult = await tailorCoverLetter(root, {
          company: registryRecord.company,
          title: registryRecord.title,
          jd_text: jdText,
          tailored_bullets: resumeResult.tailored_bullets,
        });
        const finalEntry: QueueEntry = {
          ...tailoredEntry,
          cover_letter: coverLetterResult.ok ? coverLetterResult.cover_letter : undefined,
          cover_letter_used: coverLetterResult.ok,
        };
        await adapter.saveJobForReview(registryRecord, finalEntry, `Tailored candidate, ats_score ${resumeResult.ats_score}, queued for review.`);
        counts.tailored_high_score++;
      } catch (err) {
        counts.errors++;
        console.error(`  job failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await finishRun(adminClient, run.id, "succeeded", counts, undefined);
    console.log(`run ${run.id} (user ${run.user_id}): ${JSON.stringify(counts)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(adminClient, run.id, "failed", counts, message);
    console.error(`run ${run.id} (user ${run.user_id}): FAILED: ${message}`);
  } finally {
    if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey) {
    console.error("SUPABASE_SECRET_KEY is not set: refusing to run. This must never live in a file.");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set: refusing to run.");
    process.exit(1);
  }
  const root = findProjectRoot();
  const url = process.env.SUPABASE_URL || readSupabaseConfig(root).url;
  const adminClient = createClient(url, secretKey);

  const deadline = Date.now() + RUN_BUDGET_MS;
  let processed = 0;
  for (;;) {
    if (Date.now() > deadline) {
      console.log("run budget exhausted: stopping claim loop");
      break;
    }
    const run = await claimNextReviewOnlyRun(adminClient);
    if (!run) {
      console.log(processed === 0 ? "no queued review_only runs" : "queue empty");
      break;
    }
    await processRun(adminClient, root, { ...run, startedAtMs: Date.now() });
    processed++;
  }
  console.log(`processed ${processed} run(s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
