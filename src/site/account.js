/* aplyx.app: free hosted account (Tier 0 of docs/hosted-no-agent-tiers-plan.md).
 * Real auth against aplyx's own production Supabase project, exactly the
 * backend src/tauri/src/lib/AuthContext.tsx already talks to: an account
 * created here IS an aplyx account, usable from the desktop app too, not a
 * separate website-only login. Same for the job search below: the anon key
 * embedded here is the identical public key already shipped inside the
 * desktop app's own bundle (src/core/src/supabaseConfig.ts): an anon key
 * is meant to be public; access control is Row Level Security on the
 * backend, not secrecy of this key.
 *
 * ES module (not bundled into site.js) because it needs `import` for the
 * Supabase client; everything else on this site is plain script-tag JS
 * with no build step, so this stays isolated to the one page that needs it
 * rather than converting the whole site to a module graph. */
import { supabase } from "./nav-auth.js";

// Deliberately separate project from the auth client above: same split as
// src/core/src/supabaseConfig.ts's readJobCacheSupabaseConfig: job_cache
// holds no personal data and doesn't share the auth project's I/O budget.
const JOB_CACHE_CONFIG = {
  url: "https://sxxjwzuvplwxivbqtnsx.supabase.co",
  anonKey: "sb_publishable_9mUMbIq28KZ0oHoayOJ1FQ_m7eX2U7f",
};

// Same shape as src/config/job_cache_targets.json, fetched as a same-origin
// asset since this static site can't reach outside src/site at build time.
const TARGETS_URL = "assets/job_cache_targets.json";

// Deliberately smaller than jobCache.ts's own tuned FILTERED_PER_COMPANY_LIMIT
// (75) / UNFILTERED_PER_COMPANY_LIMIT (10): those were tuned against a
// warm in-process cache serving a live app search with a tight latency
// budget; this is a one-shot page-load fetch with no such constraint, but
// there's also no value in pulling more rows than a browsing page would
// ever show.
const PER_COMPANY_LIMIT_SEARCH = 20;
const PER_COMPANY_LIMIT_BROWSE = 6;

const SOURCES = [
  { source: "ashbyhq", slugsKey: "ashby_company_slugs", label: "Ashby" },
  { source: "lever", slugsKey: "lever_company_slugs", label: "Lever" },
  { source: "greenhouse", slugsKey: "greenhouse_company_slugs", label: "Greenhouse" },
  { source: "smartrecruiters", slugsKey: "smartrecruiters_company_slugs", label: "SmartRecruiters" },
];
const SOURCE_LABELS = Object.fromEntries(SOURCES.map(({ source, label }) => [source, label]));

const authPanel = document.getElementById("auth-panel");
const dashboardPanel = document.getElementById("dashboard-panel");
const authForm = document.getElementById("auth-form");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");
const authSubmit = document.getElementById("auth-submit");
const authMessage = document.getElementById("auth-message");
const authTabs = document.querySelectorAll("[data-auth-tab]");
const googleButton = document.getElementById("google-signin");
const signOutButton = document.getElementById("sign-out");
const dashboardEmail = document.getElementById("dashboard-email");
const searchForm = document.getElementById("search-form");
const searchQuery = document.getElementById("search-query");
const searchStatus = document.getElementById("search-status");
const searchResults = document.getElementById("search-results");
const sourceChips = document.querySelectorAll("[data-source-filter]");
const dashboardTabs = document.querySelectorAll("[data-dashboard-tab]");
const dashboardTabPanels = {
  activity: document.getElementById("dashboard-tab-activity"),
  profile: document.getElementById("dashboard-tab-profile"),
  "ats-accounts": document.getElementById("dashboard-tab-ats-accounts"),
  search: document.getElementById("dashboard-tab-search"),
};
const usageBar = document.getElementById("usage-bar");
const activityStats = document.getElementById("activity-stats");
const reviewQueueList = document.getElementById("review-queue-list");
const appliedJobsList = document.getElementById("applied-jobs-list");
const jobEventsList = document.getElementById("job-events-list");
const toggleResolvedButton = document.getElementById("toggle-resolved");
const atsAccountForm = document.getElementById("ats-account-form");
const atsTenant = document.getElementById("ats-tenant");
const atsCompany = document.getElementById("ats-company");
const atsUsername = document.getElementById("ats-username");
const atsPassword = document.getElementById("ats-password");
const atsAccountSave = document.getElementById("ats-account-save");
const atsAccountMessage = document.getElementById("ats-account-message");
const atsAccountsList = document.getElementById("ats-accounts-list");

// Rows from the last real fetch, unfiltered; source-chip clicks filter
// this in place (no refetch) since it's already the full merged set.
let lastRows = [];
let activeSourceFilter = "all";
let hasSearchedOnce = false;

function activateDashboardTab(target) {
  dashboardTabs.forEach((t) => {
    const active = t.getAttribute("data-dashboard-tab") === target;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  Object.entries(dashboardTabPanels).forEach(([key, panel]) => {
    panel.hidden = key !== target;
  });
}

dashboardTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activateDashboardTab(tab.getAttribute("data-dashboard-tab"));
  });
});

let authMode = "signin"; // "signin" | "signup"

function setAuthMode(mode) {
  authMode = mode;
  authTabs.forEach((tab) => {
    const active = tab.getAttribute("data-auth-tab") === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  authSubmit.textContent = mode === "signup" ? "Create account" : "Sign in";
  authPassword.setAttribute("autocomplete", mode === "signup" ? "new-password" : "current-password");
  authMessage.textContent = "";
  authMessage.classList.remove("is-error");
}

authTabs.forEach((tab) => {
  tab.addEventListener("click", () => setAuthMode(tab.getAttribute("data-auth-tab")));
});

function showAuthed(session) {
  authPanel.hidden = true;
  dashboardPanel.hidden = false;
  dashboardEmail.textContent = session.user.email ?? "";
  // Browse-all on arrival: an empty dashboard the first time you land is
  // a worse first impression than showing something, and Tier 0's whole
  // point is "real job browsing," not just a search box.
  if (!hasSearchedOnce) {
    hasSearchedOnce = true;
    void runSearch("");
  }
  startActivitySync(session.user.id);
}

function showSignedOut() {
  authPanel.hidden = false;
  dashboardPanel.hidden = true;
  searchResults.replaceChildren();
  searchStatus.textContent = "";
  lastRows = [];
  hasSearchedOnce = false;
  stopActivitySync();
}

supabase.auth.getSession().then(({ data }) => {
  if (data.session) showAuthed(data.session);
});

// Covers the initial load AND the redirect back from Google OAuth / an
// email-confirmation link landing on this same page with a session token
// in the URL; supabase-js parses that automatically and fires this.
supabase.auth.onAuthStateChange((_event, session) => {
  if (session) {
    showAuthed(session);
  } else {
    showSignedOut();
  }
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authSubmit.disabled = true;
  authMessage.textContent = "";
  authMessage.classList.remove("is-error");

  const email = authEmail.value.trim();
  const password = authPassword.value;

  try {
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) {
        // Email confirmation required: Supabase project setting, mirrors
        // AuthContext.tsx's own signup flow in the desktop app.
        authMessage.textContent = "Check your email to confirm your account, then sign in.";
        setAuthMode("signin");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    authMessage.textContent = err && err.message ? err.message : "Something went wrong. Try again.";
    authMessage.classList.add("is-error");
  } finally {
    authSubmit.disabled = false;
  }
});

googleButton.addEventListener("click", async () => {
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
});

signOutButton.addEventListener("click", async () => {
  await supabase.auth.signOut();
});

let cachedTargets;
async function loadTargets() {
  if (cachedTargets) return cachedTargets;
  const response = await fetch(TARGETS_URL);
  cachedTargets = await response.json();
  return cachedTargets;
}

/** One job_cache_search RPC call per source: same request shape as
 *  src/core/src/jobCache.ts's postgresJobCacheSearch, reimplemented here
 *  since the browser can't import that Node module directly. Never
 *  throws; a failed/slow source just contributes zero rows rather than
 *  failing the whole search, same "degrade, don't break" contract.
 *
 *  p_query is deliberately always "" here, NOT the user's typed phrase;
 *  it's not a search filter at all. job_cache_search filters on
 *  `jc.query = p_query` (0005_job_cache_search_title_filter.sql), an
 *  exact match against the fetch-mode key a row was CACHED under, and
 *  refreshJobCache.ts writes every row under query='' (the unfiltered
 *  "browse everything" mode, see its own header comment). Passing the
 *  real search phrase here instead of p_title_words matched zero rows
 *  for any non-empty query, silently: a real bug, not "no results
 *  exist" (fixed 2026-08-26). The actual search filtering happens
 *  entirely through p_title_words' ILIKE pre-filter below. */
async function searchSource(source, companySlugs, titleWords, perCompanyLimit) {
  if (companySlugs.length === 0) return [];
  try {
    const response = await fetch(`${JOB_CACHE_CONFIG.url}/rest/v1/rpc/job_cache_search`, {
      method: "POST",
      headers: {
        apikey: JOB_CACHE_CONFIG.anonKey,
        Authorization: `Bearer ${JOB_CACHE_CONFIG.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_source: source,
        p_company_slugs: companySlugs,
        p_query: "",
        p_per_company_limit: perCompanyLimit,
        p_title_words: titleWords,
      }),
    });
    if (!response.ok) return [];
    const rows = await response.json();
    return Array.isArray(rows) ? rows.map((row) => ({ ...row, source })) : [];
  } catch {
    return [];
  }
}

/** Only ever point a result link at http(s): this data comes from the
 *  shared job_cache table, populated by our own scrapers today, but it's
 *  still external-sourced content, not literal string content, so a
 *  scheme check here costs nothing and rules out a javascript: URI ever
 *  reaching an <a href> even if a future cache-writing path got sloppy. */
function safeJobUrl(value) {
  try {
    const parsed = new URL(value, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** "2d ago" / "Today" / "3w ago" style: loose, not a full i18n formatter,
 *  matching the level of polish job-result meta text needs here. Falls
 *  back to nothing (not a raw ISO string) if posted_at is missing or
 *  unparseable, same "degrade quietly" contract as the rest of this file. */
function relativePostedAt(value) {
  if (!value) return "";
  const posted = new Date(value);
  if (Number.isNaN(posted.getTime())) return "";
  const days = Math.floor((Date.now() - posted.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "1d ago";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function renderSkeleton() {
  searchResults.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 6; i++) {
    const card = document.createElement("div");
    card.className = "job-result job-result-skeleton";
    fragment.appendChild(card);
  }
  searchResults.appendChild(fragment);
}

function renderResults(rows) {
  searchResults.replaceChildren();
  if (rows.length === 0) {
    searchStatus.textContent = hasSearchedOnce
      ? "No cached postings matched. Try a broader term, a different board, or install aplyx locally for a live, full-board search."
      : "";
    return;
  }
  searchStatus.textContent = `${rows.length} cached posting${rows.length === 1 ? "" : "s"}`;

  const fragment = document.createDocumentFragment();
  rows.forEach((row) => {
    const href = safeJobUrl(row.apply_url || row.url);
    if (!href) return;

    const link = document.createElement("a");
    link.className = "job-result";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";

    const top = document.createElement("span");
    top.className = "job-result-top";

    const company = document.createElement("span");
    company.className = "job-result-company";
    company.textContent = row.company ?? "";
    top.appendChild(company);

    const sourceBadge = document.createElement("span");
    sourceBadge.className = "job-result-source";
    sourceBadge.textContent = SOURCE_LABELS[row.source] ?? row.source ?? "";
    top.appendChild(sourceBadge);

    const title = document.createElement("span");
    title.className = "job-result-title";
    title.textContent = row.title ?? "";

    const meta = document.createElement("span");
    meta.className = "job-result-meta";
    if (row.location) {
      const location = document.createElement("span");
      location.className = "job-result-location";
      location.textContent = row.location;
      meta.appendChild(location);
    }
    if (row.pay_text) {
      const pay = document.createElement("span");
      pay.className = "job-result-pay";
      pay.textContent = row.pay_text;
      meta.appendChild(pay);
    }
    const posted = relativePostedAt(row.posted_at);
    if (posted) {
      const postedEl = document.createElement("span");
      postedEl.className = "job-result-posted";
      postedEl.textContent = posted;
      meta.appendChild(postedEl);
    }

    link.append(top, title, meta);
    fragment.appendChild(link);
  });
  searchResults.appendChild(fragment);
}

function applySourceFilter() {
  const filtered = activeSourceFilter === "all" ? lastRows : lastRows.filter((row) => row.source === activeSourceFilter);
  renderResults(filtered);
}

async function runSearch(rawQuery) {
  hasSearchedOnce = true;
  const query = rawQuery.trim();
  const titleWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const perCompanyLimit = titleWords.length > 0 ? PER_COMPANY_LIMIT_SEARCH : PER_COMPANY_LIMIT_BROWSE;

  searchStatus.textContent = "";
  renderSkeleton();

  const targets = await loadTargets().catch(() => undefined);
  if (!targets) {
    searchStatus.textContent = "Couldn't load the cached board list. Try again shortly.";
    searchResults.replaceChildren();
    return;
  }

  const resultsPerSource = await Promise.all(
    SOURCES.map(({ source, slugsKey }) =>
      searchSource(source, targets[slugsKey] || [], titleWords, perCompanyLimit),
    ),
  );
  const rows = resultsPerSource.flat();
  rows.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  lastRows = rows;
  applySourceFilter();
}

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void runSearch(searchQuery.value);
});

sourceChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    activeSourceFilter = chip.getAttribute("data-source-filter");
    sourceChips.forEach((c) => c.classList.toggle("is-active", c === chip));
    applySourceFilter();
  });
});

/* --- "My activity": a live, read-write mirror of exactly what
 * src/core/src/adapters/supabase.ts's SupabaseAdapter reads and writes for
 * the desktop app/TUI (loadState, markQueueEntryApplied, dismissQueueEntry)
 * and what src/core/src/stateDerive.ts derives (isResolved,
 * hasAppliedOrFailed, isDismissed): same tables, same status vocabulary,
 * same guard logic, ported by hand since the browser can't import that
 * TypeScript module directly. Kept deliberately faithful rather than
 * reinvented: any drift between this file and supabase.ts is a bug, not a
 * design choice. Realtime (migration 0034) is what makes this live in both
 * directions: a change from the desktop app pushes here instantly, and an
 * action taken here (mark applied / dismiss) writes through the same
 * tables the desktop app reads, so it shows up there the same way. */

let realtimeChannel;
let activitySyncDebounce;
let myState; // { jobs, applied, queue, events, profile }
let applicationAccounts = [];
let currentUserId; // from the session, not myState.profile; a profiles row
// may not exist yet if this user never completed hosted onboarding.
let setupPromptShown; // one nudge per session, see maybePromptSetup()

function stopActivitySync() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = undefined;
  }
  clearTimeout(activitySyncDebounce);
  myState = undefined;
  currentUserId = undefined;
  showResolved = false;
  toggleResolvedButton.setAttribute("aria-pressed", "false");
  toggleResolvedButton.textContent = "Show resolved";
  usageBar.hidden = true;
  usageBar.replaceChildren();
  setupPanel.hidden = true;
  setupPromptShown = false;
  activityStats.replaceChildren();
  reviewQueueList.replaceChildren();
  appliedJobsList.replaceChildren();
  jobEventsList.replaceChildren();
  atsAccountsList.replaceChildren();
  applicationAccounts = [];
}

function startActivitySync(userId) {
  currentUserId = userId;
  void loadAndRenderActivity();

  // One channel, all five tables, each filtered server-side to this user's
  // own rows; RLS already enforces this at the row level, the filter here
  // just avoids paying for events this session would immediately discard.
  // Any change on any of them just reloads the whole state and re-renders;
  // at this data volume (a single user's own job history) that's simpler
  // and far less bug-prone than hand-rolled incremental patching, and the
  // debounce below keeps a burst of writes (e.g. a fit-gate batch) from
  // triggering a reload per row.
  realtimeChannel = supabase
    .channel(`activity-${userId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "jobs", filter: `user_id=eq.${userId}` }, scheduleActivityReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "job_events", filter: `user_id=eq.${userId}` }, scheduleActivityReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "applied_jobs", filter: `user_id=eq.${userId}` }, scheduleActivityReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "review_queue", filter: `user_id=eq.${userId}` }, scheduleActivityReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: `user_id=eq.${userId}` }, scheduleActivityReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "application_accounts", filter: `user_id=eq.${userId}` }, scheduleActivityReload)
    .subscribe();
}

function scheduleActivityReload() {
  clearTimeout(activitySyncDebounce);
  activitySyncDebounce = setTimeout(() => void loadAndRenderActivity(), 400);
}

/** Same Range-header pagination as supabase.ts's fetchAllRows: a plain
 *  unranged .select("*") silently caps at 1,000 rows server-side, which
 *  was a real, previously-fixed bug there (see that file's own comment).
 *  Ordered by orderCol ascending, looping until a page comes back short. */
async function fetchAllRows(table, orderCol) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order(orderCol, { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function loadMyState() {
  const [{ data: profile }, jobs, applied, queue, events] = await Promise.all([
    supabase.from("profiles").select("*").maybeSingle(),
    fetchAllRows("jobs", "created_at"),
    fetchAllRows("applied_jobs", "created_at"),
    fetchAllRows("review_queue", "created_at"),
    fetchAllRows("job_events", "recorded_at"),
  ]);
  return { profile: profile ?? undefined, jobs, applied, queue, events };
}

// --- Derivation logic, ported verbatim from src/core/src/stateDerive.ts ---

function registryByJobId(jobs, jobId) {
  return jobs.find((r) => r.job_id === jobId);
}

function isResolved(state, entry) {
  const outcome = state.applied.find((a) => a.job_id === entry.job_id && a.status !== "needs_review");
  if (outcome) return true;
  const rec = registryByJobId(state.jobs, entry.job_id);
  return rec?.latest_status === "applied" || rec?.latest_status === "failed" || rec?.latest_status === "skipped_unfit";
}

function hasAppliedOrFailed(state, entry) {
  const outcome = state.applied.find((a) => a.job_id === entry.job_id && (a.status === "applied" || a.status === "failed"));
  if (outcome) return true;
  const rec = registryByJobId(state.jobs, entry.job_id);
  return rec?.latest_status === "applied" || rec?.latest_status === "failed";
}

function isDismissed(state, entry) {
  const rec = registryByJobId(state.jobs, entry.job_id);
  return rec?.latest_status === "skipped_unfit";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// --- Actions, ported from SupabaseAdapter.markQueueEntryApplied/dismissQueueEntry ---

async function recordJobEvent(userId, jobKey, status, reasoning, company, title, url) {
  const { error: insertError } = await supabase
    .from("job_events")
    .insert({ user_id: userId, job_key: jobKey, status, reasoning, company, title, url });
  if (insertError) throw insertError;
  const { error: updateError } = await supabase.from("jobs").update({ latest_status: status }).eq("user_id", userId).eq("job_key", jobKey);
  if (updateError) throw updateError;
}

async function markQueueEntryApplied(userId, entry) {
  const reg = registryByJobId(myState.jobs, entry.job_id);
  if (!reg?.job_key) {
    throw new Error(`Cannot mark applied: no registry record for "${entry.company}: ${entry.title}". This job was never canonicalized.`);
  }
  const reasoning = "Marked applied manually via the web dashboard";
  const payload = {
    user_id: userId,
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
  };
  const { data: existing, error: existingError } = await supabase
    .from("applied_jobs")
    .select("status")
    .eq("user_id", userId)
    .eq("job_id", entry.job_id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.status === "needs_review") {
    const { error: updateError } = await supabase.from("applied_jobs").update(payload).eq("user_id", userId).eq("job_id", entry.job_id);
    if (updateError) throw updateError;
  } else {
    const { error: insertError } = await supabase.from("applied_jobs").insert(payload);
    if (insertError && insertError.code !== "23505") throw insertError;
  }
  await recordJobEvent(userId, reg.job_key, "applied", reasoning, entry.company, entry.title, entry.url);
}

async function dismissQueueEntry(userId, entry) {
  if (hasAppliedOrFailed(myState, entry)) {
    throw new Error(`Cannot dismiss: "${entry.company}: ${entry.title}" already has an applied/failed outcome.`);
  }
  if (isDismissed(myState, entry)) {
    return; // already dismissed; no-op, matches SupabaseAdapter's own idempotent behavior
  }
  const reg = registryByJobId(myState.jobs, entry.job_id);
  if (!reg?.job_key) {
    throw new Error(`Cannot dismiss: no registry record for "${entry.company}: ${entry.title}".`);
  }
  await recordJobEvent(userId, reg.job_key, "skipped_unfit", "Dismissed via the web dashboard", entry.company, entry.title, entry.url);
}

// --- Rendering ---

let showResolved = false;

toggleResolvedButton.addEventListener("click", () => {
  showResolved = !showResolved;
  toggleResolvedButton.setAttribute("aria-pressed", String(showResolved));
  toggleResolvedButton.textContent = showResolved ? "Hide resolved" : "Show resolved";
  renderReviewQueue();
});

/* Hosted daily-run quota, per docs/hosted-paid-tier-plan.md's
 * "Usage-limit tracking" section: get_own_usage() (migration 0035)
 * returns a real count against hosted_runs and a cap derived from
 * subscriptions.status = 'active', or plan = 'free_hosted' / cap = null
 * when there's no active subscription, which is every account today (no
 * Stripe integration exists yet). Only ever called from
 * loadAndRenderActivity(), itself only reachable once signed in
 * (startActivitySync); never runs for a signed-out visitor, and this
 * whole dashboard is unreachable without a hosted account in the first
 * place, so a local-only install never sees it either. */
async function renderUsageBar() {
  usageBar.replaceChildren();
  const { data, error } = await supabase.rpc("get_own_usage");
  if (error || !data || data.length === 0) {
    usageBar.hidden = true;
    return;
  }
  const { used_today, cap, plan } = data[0];
  usageBar.hidden = false;

  if (cap === null) {
    const note = document.createElement("p");
    note.className = "usage-bar-free";
    const badge = document.createElement("span");
    badge.className = "account-tier-badge";
    badge.textContent = "Free account";
    note.append(badge, document.createTextNode(": search and autofill included, no daily cap."));
    usageBar.appendChild(note);
    return;
  }

  const pct = Math.min(100, Math.round((used_today / cap) * 100));
  const head = document.createElement("div");
  head.className = "usage-bar-head";
  const label = document.createElement("span");
  label.textContent = `${plan[0].toUpperCase()}${plan.slice(1)} plan: hosted runs today`;
  const count = document.createElement("span");
  count.className = "usage-bar-count";
  count.textContent = `${used_today} / ${cap}`;
  head.append(label, count);

  const track = document.createElement("div");
  track.className = "usage-bar-track";
  const fill = document.createElement("div");
  fill.className = "usage-bar-fill";
  fill.style.width = `${pct}%`;
  track.appendChild(fill);

  usageBar.append(head, track);
}

function renderStats() {
  activityStats.replaceChildren();
  if (!myState) return;
  const counts = { applied: 0, needs_review: 0, skipped_unfit: 0, failed: 0 };
  myState.jobs.forEach((row) => {
    if (row.latest_status in counts) counts[row.latest_status] += 1;
  });
  const pendingReview = myState.queue.filter((entry) => !isResolved(myState, entry)).length;
  const stats = [
    { label: "Applied", value: counts.applied },
    { label: "Waiting in review", value: pendingReview },
    { label: "Skipped (not a fit)", value: counts.skipped_unfit },
    { label: "Failed", value: counts.failed },
  ];
  const fragment = document.createDocumentFragment();
  stats.forEach(({ label, value }) => {
    const card = document.createElement("div");
    card.className = "activity-stat";
    const num = document.createElement("span");
    num.className = "activity-stat-value";
    num.textContent = String(value);
    const lab = document.createElement("span");
    lab.className = "activity-stat-label";
    lab.textContent = label;
    card.append(num, lab);
    fragment.appendChild(card);
  });
  activityStats.appendChild(fragment);
}

function activityRow(entry, { badge, badgeClass, actions } = {}) {
  const row = document.createElement("div");
  row.className = "activity-row";

  const text = document.createElement("div");
  text.className = "activity-row-text";
  const title = document.createElement("span");
  title.className = "activity-row-title";
  title.textContent = `${entry.company ?? ""}: ${entry.title ?? ""}`;
  text.appendChild(title);
  if (entry.date_applied || entry.location_tier) {
    const meta = document.createElement("span");
    meta.className = "activity-row-meta";
    meta.textContent = [entry.date_applied, entry.location_tier].filter(Boolean).join(" · ");
    text.appendChild(meta);
  }
  row.appendChild(text);

  if (badge) {
    const badgeEl = document.createElement("span");
    badgeEl.className = `activity-badge ${badgeClass ?? ""}`;
    badgeEl.textContent = badge;
    row.appendChild(badgeEl);
  }

  if (actions && actions.length > 0) {
    const actionsEl = document.createElement("div");
    actionsEl.className = "activity-row-actions";
    actions.forEach(({ label, onClick, variant }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${variant === "primary" ? "btn-primary" : "btn-secondary"} activity-action`;
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      actionsEl.appendChild(btn);
    });
    row.appendChild(actionsEl);
  }

  return row;
}

function renderReviewQueue() {
  reviewQueueList.replaceChildren();
  if (!myState) return;
  const userId = currentUserId;
  const entries = myState.queue.filter((entry) => showResolved || !isResolved(myState, entry));
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = showResolved ? "No review-queue entries yet." : "Nothing waiting on a decision.";
    reviewQueueList.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => {
    const resolved = isResolved(myState, entry);
    const dismissed = isDismissed(myState, entry);
    const row = activityRow(entry, {
      badge: resolved ? (dismissed ? "Skipped" : "Resolved") : "Pending",
      badgeClass: resolved ? "activity-badge-muted" : "activity-badge-pending",
      actions: resolved
        ? []
        : [
            {
              label: "Mark applied",
              variant: "primary",
              onClick: async (e) => {
                e.currentTarget.disabled = true;
                try {
                  await markQueueEntryApplied(userId, entry);
                } catch (err) {
                  alert(err?.message ?? "Couldn't mark this applied.");
                  e.currentTarget.disabled = false;
                }
              },
            },
            {
              label: "Dismiss",
              onClick: async (e) => {
                e.currentTarget.disabled = true;
                try {
                  await dismissQueueEntry(userId, entry);
                } catch (err) {
                  alert(err?.message ?? "Couldn't dismiss this.");
                  e.currentTarget.disabled = false;
                }
              },
            },
          ],
    });
    fragment.appendChild(row);
  });
  reviewQueueList.appendChild(fragment);
}

function renderAppliedJobs() {
  appliedJobsList.replaceChildren();
  if (!myState) return;
  const rows = [...myState.applied].sort((a, b) => (b.date_applied ?? "").localeCompare(a.date_applied ?? "")).slice(0, 20);
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = "Nothing applied yet.";
    appliedJobsList.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((entry) => {
    fragment.appendChild(
      activityRow(entry, {
        badge: entry.status === "needs_review" ? "Needs review" : entry.status === "failed" ? "Failed" : "Applied",
        badgeClass: entry.status === "failed" ? "activity-badge-danger" : entry.status === "needs_review" ? "activity-badge-pending" : "activity-badge-good",
      }),
    );
  });
  appliedJobsList.appendChild(fragment);
}

function renderJobEvents() {
  jobEventsList.replaceChildren();
  if (!myState) return;
  const rows = [...myState.events].sort((a, b) => (b.recorded_at ?? "").localeCompare(a.recorded_at ?? "")).slice(0, 15);
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = "No activity yet. Once a search runs on your install, it'll show up here.";
    jobEventsList.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((event) => {
    const row = document.createElement("div");
    row.className = "activity-event";
    const label = document.createElement("span");
    label.textContent = `${event.status}: ${event.company ?? ""} ${event.title ?? ""}`.trim();
    const when = document.createElement("span");
    when.className = "activity-event-when";
    when.textContent = relativePostedAt(event.recorded_at) || "";
    row.append(label, when);
    fragment.appendChild(row);
  });
  jobEventsList.appendChild(fragment);
}

async function loadApplicationAccounts() {
  const { data, error } = await supabase.rpc("get_application_account_metadata");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    company_name: String(row.company_name ?? ""),
    ats_family: String(row.ats_family ?? ""),
    tenant_key: String(row.tenant_key ?? ""),
    login_hint: row.login_hint ? String(row.login_hint) : "",
    status: String(row.status ?? ""),
    verification_status: String(row.verification_status ?? ""),
  }));
}

function renderApplicationAccounts() {
  atsAccountsList.replaceChildren();
  if (applicationAccounts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = "No ATS accounts stored yet.";
    atsAccountsList.appendChild(empty);
    return;
  }
  applicationAccounts.forEach((account) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    const text = document.createElement("div");
    text.className = "activity-row-text";
    const title = document.createElement("span");
    title.className = "activity-row-title";
    title.textContent = `${account.company_name}: ${account.ats_family}`;
    const meta = document.createElement("span");
    meta.className = "activity-row-meta";
    meta.textContent = [account.login_hint || "login masked", account.tenant_key, account.verification_status.replaceAll("_", " ")].join(" · ");
    text.append(title, meta);
    const badge = document.createElement("span");
    badge.className = "activity-badge activity-badge-good";
    badge.textContent = account.status.replaceAll("_", " ");
    row.append(text, badge);
    atsAccountsList.appendChild(row);
  });
}

async function loadAndRenderActivity() {
  try {
    myState = await loadMyState();
  } catch {
    return; // transient fetch failure; next Realtime event or tab revisit retries
  }
  try {
    applicationAccounts = await loadApplicationAccounts();
  } catch {
    applicationAccounts = [];
  }
  renderStats();
  void renderUsageBar();
  renderReviewQueue();
  renderAppliedJobs();
  renderJobEvents();
  renderApplicationAccounts();
  renderProfileForm();
  updateSetupGate();
}

atsAccountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  atsAccountSave.disabled = true;
  atsAccountMessage.textContent = "";
  atsAccountMessage.classList.remove("is-error");
  try {
    const rawTenant = atsTenant.value.trim();
    const tenantUrl = new URL(rawTenant.includes("://") ? rawTenant : `https://${rawTenant}`);
    const tenantKey = tenantUrl.hostname.toLowerCase();
    if (!tenantKey.endsWith(".myworkdayjobs.com") || tenantKey === ".myworkdayjobs.com") {
      throw new Error("Workday tenant must be a hostname ending in .myworkdayjobs.com");
    }
    const company = atsCompany.value.trim();
    const username = atsUsername.value.trim();
    const password = atsPassword.value;
    if (!company || !username || !password) throw new Error("Company, account email, and password are required.");
    const { data: accountId, error: createError } = await supabase.rpc("create_application_account", {
      p_ats_family: "workday",
      p_tenant_key: tenantKey,
      p_company_name: company,
      p_username: username,
      p_password: password,
    });
    if (createError) throw createError;
    const { error: rotateError } = await supabase.rpc("rotate_application_account_secret", {
      p_account_id: accountId,
      p_new_username: username,
      p_new_password: password,
    });
    if (rotateError) throw rotateError;
    atsPassword.value = "";
    atsAccountMessage.textContent = "Workday credential saved to the online vault. Sign into the desktop app to sync it to a local device.";
    applicationAccounts = await loadApplicationAccounts();
    renderApplicationAccounts();
  } catch (err) {
    atsAccountMessage.textContent = err?.message ?? "Couldn't save the ATS credential.";
    atsAccountMessage.classList.add("is-error");
  } finally {
    atsAccountSave.disabled = false;
  }
});

/* --- Profile: the same PII fields + 3 preference fields
 * src/core/src/onboarding/fields.ts's wizard collects (FIELD_IDS.length,
 * kept in sync by hand here since this file has no bundler to import that
 * constant from), one page at a time, in the desktop app. Here as one
 * scrollable form instead of 8 wizard pages (no "next page" ceremony
 * needed for an edit, unlike first-time setup), writing all fields in a
 * single upsert rather than SupabaseAdapter.writeProfileField's
 * one-upsert-per-field loop; same end state, far fewer round trips.
 *
 * This is genuinely the same account.js is already reading via
 * loadMyState()'s myState.profile; no separate fetch. */

const PROFILE_PAGES = [
  {
    title: "Basics",
    fields: [
      { id: "preferred_name", label: "Preferred name (optional)", kind: "text", placeholder: "how aplyx addresses you" },
      { id: "first_name", label: "Legal first name", kind: "text" },
      { id: "last_name", label: "Legal last name", kind: "text" },
    ],
  },
  {
    title: "Contact",
    fields: [
      { id: "email", label: "Email applications are sent from", kind: "text", placeholder: "you@example.com" },
      { id: "phone", label: "Phone number", kind: "text", placeholder: "555-0142" },
      { id: "address_line1", label: "Address line 1", kind: "text", placeholder: "123 Example St" },
      { id: "address_line2", label: "Address line 2 (optional)", kind: "text", placeholder: "Apt 4B" },
      { id: "zip_code", label: "Zip code", kind: "text", placeholder: "12345" },
    ],
  },
  {
    title: "Location",
    fields: [{ id: "location", label: "Home location (city, state)", kind: "text", placeholder: "e.g. Seattle, WA" }],
  },
  {
    title: "Profiles",
    fields: [
      { id: "linkedin_username", label: "LinkedIn username", kind: "text", placeholder: "your-username" },
      { id: "github_username", label: "GitHub username", kind: "text", placeholder: "your-username" },
    ],
  },
  {
    title: "Work eligibility",
    fields: [
      { id: "authorized_to_work", label: "Authorized to work in the US?", kind: "yesno" },
      { id: "require_sponsorship", label: "Need visa sponsorship?", kind: "yesno" },
      {
        id: "citizenship_status",
        label: "Work authorization status (optional)",
        kind: "select3",
        options: [
          { value: "U.S. Citizen", label: "U.S. Citizen" },
          { value: "U.S. National", label: "U.S. National" },
          { value: "U.S. Permanent Resident", label: "U.S. Permanent Resident" },
          { value: "Refugee or Asylee", label: "Refugee or Asylee" },
          { value: "Other work authorization", label: "Other work authorization" },
        ],
      },
    ],
  },
  {
    title: "Education",
    fields: [
      { id: "graduation_date", label: "Graduation date", kind: "text", placeholder: "June 2027" },
      { id: "gpa", label: "GPA (optional)", kind: "text", placeholder: "3.8" },
      { id: "currently_enrolled", label: "Currently enrolled in school?", kind: "yesno" },
    ],
  },
  {
    title: "Demographics",
    fields: [
      {
        id: "gender",
        label: "Gender (optional)",
        kind: "select3",
        options: [
          { value: "Male", label: "Male" },
          { value: "Female", label: "Female" },
          { value: "Non-binary", label: "Non-binary" },
          { value: "Decline to self-identify", label: "Decline to self-identify" },
        ],
      },
      { id: "ethnicity", label: "Ethnicity (optional)", kind: "text", placeholder: "e.g. Asian / Decline" },
      { id: "hispanic_or_latino", label: "Hispanic or Latino?", kind: "yesno" },
      { id: "date_of_birth", label: "Date of birth (optional)", kind: "text", placeholder: "MM/DD/YYYY" },
      {
        id: "veteran_status",
        label: "Veteran status",
        kind: "select3",
        options: [
          { value: "not_veteran", label: "Not a veteran" },
          { value: "veteran", label: "Veteran" },
          { value: "decline", label: "Prefer not to answer" },
        ],
      },
      {
        id: "disability_status",
        label: "Disability status",
        kind: "select3",
        options: [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" },
          { value: "decline", label: "Prefer not to answer" },
        ],
      },
    ],
  },
  {
    title: "Roles",
    fields: [{ id: "role_keywords", label: "Roles you're targeting (comma-separated)", kind: "list", placeholder: "software engineer, swe, ..." }],
  },
  {
    title: "Job targets",
    fields: [
      { id: "preferred_locations", label: "Preferred job locations, comma-separated (optional)", kind: "list", placeholder: "Seattle, WA; Remote" },
      { id: "target_companies", label: "Target companies, comma-separated (optional)", kind: "list", placeholder: "Stripe, Figma, ..." },
    ],
  },
];

const PREFERENCE_FIELD_IDS = new Set(["role_keywords", "preferred_locations", "target_companies"]);

const profileForm = document.getElementById("profile-form");
const profileFormFields = document.getElementById("profile-form-fields");
const profileMessage = document.getElementById("profile-message");
let profileDirty = false;

/** One <fieldset> of a page's fields, `idPrefix` keeping element ids
 *  unique between the two forms that now render this same PROFILE_PAGES
 *  data (the Profile tab's full form and the setup walkthrough's
 *  step-one form below). */
function buildProfileFieldset(page, idPrefix) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "profile-fieldset";
  const legend = document.createElement("legend");
  legend.textContent = page.title;
  fieldset.appendChild(legend);

  page.fields.forEach((field) => {
    const label = document.createElement("label");
    label.className = "account-field profile-field";
    const span = document.createElement("span");
    span.textContent = field.label;
    label.appendChild(span);

    let input;
    if (field.kind === "yesno" || field.kind === "select3") {
      input = document.createElement("select");
      const options = field.kind === "yesno" ? [{ value: "", label: "Not answered" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }] : [{ value: "", label: "Not answered" }, ...field.options];
      options.forEach((opt) => {
        const optionEl = document.createElement("option");
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        input.appendChild(optionEl);
      });
    } else {
      input = document.createElement("input");
      input.type = "text";
      if (field.placeholder) input.placeholder = field.placeholder;
    }
    input.id = `${idPrefix}${field.id}`;
    input.dataset.fieldId = field.id;
    input.dataset.fieldKind = field.kind;
    label.appendChild(input);
    fieldset.appendChild(label);
  });
  return fieldset;
}

function buildProfileFormInto(container, idPrefix, onInput) {
  const fragment = document.createDocumentFragment();
  PROFILE_PAGES.forEach((page) => {
    const fieldset = buildProfileFieldset(page, idPrefix);
    if (onInput) fieldset.querySelectorAll("[data-field-id]").forEach((input) => input.addEventListener("input", onInput));
    fragment.appendChild(fieldset);
  });
  container.appendChild(fragment);
}
buildProfileFormInto(profileFormFields, "profile-field-", () => {
  profileDirty = true;
});

/** Re-populates a profile form's inputs from a profile row. Shared by the
 *  Profile tab's renderProfileForm() below and the setup walkthrough. */
function populateProfileFields(container, profile) {
  const preferences = profile.preferences ?? {};
  container.querySelectorAll("[data-field-id]").forEach((input) => {
    const id = input.dataset.fieldId;
    if (PREFERENCE_FIELD_IDS.has(id)) {
      input.value = Array.isArray(preferences[id]) ? preferences[id].join(", ") : "";
    } else {
      input.value = profile[id] != null ? String(profile[id]) : "";
    }
  });
}

/** Re-populates form values from myState.profile; skipped while the form
 *  is dirty (the user has typed something not yet saved) so a Realtime
 *  update from another device/tab never silently overwrites an
 *  in-progress edit. The dirty flag clears on a successful save, so the
 *  next sync after that is free to refresh the form again. */
function renderProfileForm() {
  if (!myState || profileDirty) return;
  populateProfileFields(profileFormFields, myState.profile ?? {});
}

/** Reads a profile form's current input values into an upsert-ready
 *  payload. Shared by the Profile tab's submit handler and the setup
 *  walkthrough's per-step saves. */
function collectProfilePayload(container, userId) {
  const payload = { user_id: userId };
  const preferences = {};
  container.querySelectorAll("[data-field-id]").forEach((input) => {
    const id = input.dataset.fieldId;
    if (PREFERENCE_FIELD_IDS.has(id)) {
      preferences[id] = input.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      payload[id] = input.value.trim();
    }
  });
  payload.preferences = preferences;
  return payload;
}

async function saveProfilePayload(payload) {
  const { error } = await supabase.from("profiles").upsert(payload, { onConflict: "user_id" });
  if (error) throw error;
}

profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUserId) return;
  const saveButton = document.getElementById("profile-save");
  saveButton.disabled = true;
  profileMessage.textContent = "Saving…";
  profileMessage.classList.remove("is-error");
  try {
    await saveProfilePayload(collectProfilePayload(profileFormFields, currentUserId));
    profileDirty = false;
    profileMessage.textContent = "Saved.";
    void loadAndRenderActivity();
  } catch (err) {
    profileMessage.textContent = err?.message ?? "Couldn't save. Try again.";
    profileMessage.classList.add("is-error");
  } finally {
    saveButton.disabled = false;
  }
});

/* --- Setup walkthrough (account.html #setup-panel): the guided sequence
 * a brand-new signup ("no profiles row yet") sees instead of the
 * dashboard, replacing the single banner-to-a-tab nudge this used to be.
 * Reuses the same PROFILE_PAGES field set and save path as the Profile
 * tab above (buildProfileFormInto/populateProfileFields/
 * collectProfilePayload/saveProfilePayload): a different *sequence* over
 * the identical data, not a second data model.
 *
 * Deliberately does NOT write profiles.onboarding_completed: that flag
 * also gates the desktop hosted wizard's own "Finish hosted setup" step
 * (HostedReadinessStep.tsx), which additionally requires an inbox
 * connection this walkthrough doesn't collect (out of scope here, see
 * docs/web-onboarding-hosted-sync-plan.md). Finishing this walkthrough
 * only means "don't show it again this session," tracked the same
 * once-per-session way setupPromptShown already worked before. */

const setupPanel = document.getElementById("setup-panel");
const setupProgressLabel = document.getElementById("setup-progress-label");
const setupProgressFill = document.getElementById("setup-progress-fill");
const SETUP_STEP_ORDER = ["profile", "email", "resume", "finish"];
const setupStepEls = {
  profile: document.getElementById("setup-step-profile"),
  email: document.getElementById("setup-step-email"),
  resume: document.getElementById("setup-step-resume"),
  finish: document.getElementById("setup-step-finish"),
};
const setupProfileFields = document.getElementById("setup-profile-fields");
const setupProfileMessage = document.getElementById("setup-profile-message");
const setupEmailInput = document.getElementById("setup-email-input");
const setupEmailMessage = document.getElementById("setup-email-message");
const setupResumeInput = document.getElementById("setup-resume-input");
const setupResumeChoose = document.getElementById("setup-resume-choose");
const setupResumeMessage = document.getElementById("setup-resume-message");
const setupChecklist = document.getElementById("setup-checklist");

buildProfileFormInto(setupProfileFields, "setup-field-");

// Tracked locally rather than read back from myState.profile at checklist
// time; myState only refreshes on the next Realtime tick or an explicit
// loadAndRenderActivity() call, neither of which happens between a step
// save and viewing the finish step's checklist a few seconds later.
let setupProfileFilled = false;

function showSetupStep(step) {
  setupStepEls[step].hidden = false;
  SETUP_STEP_ORDER.filter((key) => key !== step).forEach((key) => {
    setupStepEls[key].hidden = true;
  });
  const index = SETUP_STEP_ORDER.indexOf(step);
  setupProgressLabel.textContent = `Step ${index + 1} of ${SETUP_STEP_ORDER.length}`;
  setupProgressFill.style.width = `${((index + 1) / SETUP_STEP_ORDER.length) * 100}%`;
}

/** Shown for a brand-new signup instead of the dashboard, once per
 *  session: same "has this account entered anything" check
 *  ImportOrFreshStep.tsx (and the banner this replaced) already used. */
function updateSetupGate() {
  if (myState.profile?.first_name) {
    setupPanel.hidden = true;
    return;
  }
  if (setupPromptShown) return; // already shown (or finished/dismissed) this session
  setupPromptShown = true;
  populateProfileFields(setupProfileFields, myState.profile ?? {});
  setupEmailInput.value = myState.profile?.email ?? "";
  showSetupStep("profile");
  dashboardPanel.hidden = true;
  setupPanel.hidden = false;
}

document.getElementById("setup-profile-continue").addEventListener("click", async function saveSetupProfile() {
  if (!currentUserId) return;
  this.disabled = true;
  setupProfileMessage.textContent = "Saving…";
  setupProfileMessage.classList.remove("is-error");
  try {
    const payload = collectProfilePayload(setupProfileFields, currentUserId);
    await saveProfilePayload(payload);
    setupProfileFilled = Boolean(payload.first_name && payload.last_name);
    setupEmailInput.value = payload.email || "";
    setupProfileMessage.textContent = "";
    showSetupStep("email");
  } catch (err) {
    setupProfileMessage.textContent = err?.message ?? "Couldn't save. Try again.";
    setupProfileMessage.classList.add("is-error");
  } finally {
    this.disabled = false;
  }
});

document.getElementById("setup-email-back").addEventListener("click", () => showSetupStep("profile"));

document.getElementById("setup-email-continue").addEventListener("click", async function saveSetupEmail() {
  if (!currentUserId) return;
  this.disabled = true;
  setupEmailMessage.textContent = "Saving…";
  setupEmailMessage.classList.remove("is-error");
  try {
    await saveProfilePayload({ user_id: currentUserId, email: setupEmailInput.value.trim() });
    setupEmailMessage.textContent = "";
    showSetupStep("resume");
  } catch (err) {
    setupEmailMessage.textContent = err?.message ?? "Couldn't save. Try again.";
    setupEmailMessage.classList.add("is-error");
  } finally {
    this.disabled = false;
  }
});

document.getElementById("setup-resume-back").addEventListener("click", () => showSetupStep("email"));

setupResumeChoose.addEventListener("click", () => setupResumeInput.click());

setupResumeInput.addEventListener("change", async () => {
  const file = setupResumeInput.files?.[0];
  if (!file || !currentUserId) return;
  setupResumeChoose.disabled = true;
  setupResumeMessage.textContent = "Uploading…";
  setupResumeMessage.classList.remove("is-error");
  try {
    const { error } = await supabase.storage.from("resumes").upload(`${currentUserId}/${file.name}`, file, { upsert: true });
    if (error) throw error;
    setupResumeMessage.textContent = `Uploaded ${file.name}.`;
    setupResumeChoose.textContent = `Replace ${file.name}…`;
  } catch (err) {
    setupResumeMessage.textContent = err?.message ?? "Upload failed. Try again.";
    setupResumeMessage.classList.add("is-error");
  } finally {
    setupResumeChoose.disabled = false;
  }
});

document.getElementById("setup-resume-continue").addEventListener("click", () => {
  void renderSetupChecklist();
  showSetupStep("finish");
});

document.getElementById("setup-finish-back").addEventListener("click", () => showSetupStep("resume"));

document.getElementById("setup-finish-done").addEventListener("click", () => {
  setupPanel.hidden = true;
  dashboardPanel.hidden = false;
  void loadAndRenderActivity();
});

function setupChecklistRow(ok, label, detail) {
  const row = document.createElement("div");
  row.className = "setup-checklist-row";
  const icon = document.createElement("span");
  icon.className = `setup-checklist-icon ${ok ? "setup-checklist-icon-ok" : "setup-checklist-icon-pending"}`;
  icon.textContent = ok ? "✓" : "–";
  const text = document.createElement("div");
  const labelEl = document.createElement("div");
  labelEl.className = "setup-checklist-label";
  labelEl.textContent = label;
  const detailEl = document.createElement("div");
  detailEl.className = "setup-checklist-detail";
  detailEl.textContent = detail;
  text.append(labelEl, detailEl);
  row.append(icon, text);
  return row;
}

/** Resume-presence check: same storage.list()-then-filter-dotfiles logic
 *  as SupabaseAdapter.readHostedReadiness(), reimplemented here since the
 *  browser can't import that Node module (see loadMyState's neighboring
 *  functions for the same constraint elsewhere on this page). */
async function checkResumeUploaded() {
  if (!currentUserId) return false;
  try {
    const { data, error } = await supabase.storage.from("resumes").list(currentUserId);
    if (error) throw error;
    return (data ?? []).some((entry) => entry.name && !entry.name.startsWith("."));
  } catch {
    return false;
  }
}

async function renderSetupChecklist() {
  const email = setupEmailInput.value.trim();
  const resumeUploaded = await checkResumeUploaded();
  setupChecklist.replaceChildren(
    setupChecklistRow(
      setupProfileFilled,
      "Profile",
      setupProfileFilled ? "Name, contact, and preferences saved." : "Not filled in yet. Finish it any time from the Profile tab.",
    ),
    setupChecklistRow(Boolean(email), "Applying-from email", email || "Not set yet."),
    setupChecklistRow(
      resumeUploaded,
      "Resume",
      resumeUploaded ? "Uploaded and ready." : "Not uploaded yet. Add one any time from the Profile tab.",
    ),
  );
}
