/* aplyx.app — free hosted account (Tier 0 of docs/hosted-no-agent-tiers-plan.md).
 * Real auth against aplyx's own production Supabase project, exactly the
 * backend src/tauri/src/lib/AuthContext.tsx already talks to — an account
 * created here IS an aplyx account, usable from the desktop app too, not a
 * separate website-only login. Same for the job search below: the anon key
 * embedded here is the identical public key already shipped inside the
 * desktop app's own bundle (src/core/src/supabaseConfig.ts) — an anon key
 * is meant to be public; access control is Row Level Security on the
 * backend, not secrecy of this key.
 *
 * ES module (not bundled into site.js) because it needs `import` for the
 * Supabase client — everything else on this site is plain script-tag JS
 * with no build step, so this stays isolated to the one page that needs it
 * rather than converting the whole site to a module graph. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AUTH_CONFIG = {
  url: "https://aedejjesqcbndphkldfs.supabase.co",
  anonKey: "sb_publishable_d3pJdWv70x7tYbDEWoGkFw_HCUpS1_i",
};

// Deliberately separate project from AUTH_CONFIG above — same split as
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
// (75) / UNFILTERED_PER_COMPANY_LIMIT (10) — those were tuned against a
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

const supabase = createClient(AUTH_CONFIG.url, AUTH_CONFIG.anonKey);

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
  search: document.getElementById("dashboard-tab-search"),
};
const activityStats = document.getElementById("activity-stats");
const reviewQueueList = document.getElementById("review-queue-list");
const appliedJobsList = document.getElementById("applied-jobs-list");
const jobEventsList = document.getElementById("job-events-list");
const toggleResolvedButton = document.getElementById("toggle-resolved");

// Rows from the last real fetch, unfiltered — source-chip clicks filter
// this in place (no refetch) since it's already the full merged set.
let lastRows = [];
let activeSourceFilter = "all";
let hasSearchedOnce = false;

dashboardTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.getAttribute("data-dashboard-tab");
    dashboardTabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    Object.entries(dashboardTabPanels).forEach(([key, panel]) => {
      panel.hidden = key !== target;
    });
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
  // Browse-all on arrival — an empty dashboard the first time you land is
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
// in the URL — supabase-js parses that automatically and fires this.
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
        // Email confirmation required — Supabase project setting, mirrors
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

/** One job_cache_search RPC call per source — same request shape as
 *  src/core/src/jobCache.ts's postgresJobCacheSearch, reimplemented here
 *  since the browser can't import that Node module directly. Never
 *  throws; a failed/slow source just contributes zero rows rather than
 *  failing the whole search, same "degrade, don't break" contract.
 *
 *  p_query is deliberately always "" here, NOT the user's typed phrase —
 *  it's not a search filter at all. job_cache_search filters on
 *  `jc.query = p_query` (0005_job_cache_search_title_filter.sql), an
 *  exact match against the fetch-mode key a row was CACHED under, and
 *  refreshJobCache.ts writes every row under query='' (the unfiltered
 *  "browse everything" mode — see its own header comment). Passing the
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

/** Only ever point a result link at http(s) — this data comes from the
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

/** "2d ago" / "Today" / "3w ago" style — loose, not a full i18n formatter,
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

/* --- "My activity" — a live, read-write mirror of exactly what
 * src/core/src/adapters/supabase.ts's SupabaseAdapter reads and writes for
 * the desktop app/TUI (loadState, markQueueEntryApplied, dismissQueueEntry)
 * and what src/core/src/stateDerive.ts derives (isResolved,
 * hasAppliedOrFailed, isDismissed) — same tables, same status vocabulary,
 * same guard logic, ported by hand since the browser can't import that
 * TypeScript module directly. Kept deliberately faithful rather than
 * reinvented: any drift between this file and supabase.ts is a bug, not a
 * design choice. Realtime (migration 0034) is what makes this live in both
 * directions — a change from the desktop app pushes here instantly, and an
 * action taken here (mark applied / dismiss) writes through the same
 * tables the desktop app reads, so it shows up there the same way. */

let realtimeChannel;
let activitySyncDebounce;
let myState; // { jobs, applied, queue, events, profile }
let currentUserId; // from the session, not myState.profile — a profiles row
// may not exist yet if this user never completed hosted onboarding.

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
  activityStats.replaceChildren();
  reviewQueueList.replaceChildren();
  appliedJobsList.replaceChildren();
  jobEventsList.replaceChildren();
}

function startActivitySync(userId) {
  currentUserId = userId;
  void loadAndRenderActivity();

  // One channel, all five tables, each filtered server-side to this user's
  // own rows — RLS already enforces this at the row level, the filter here
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
    .subscribe();
}

function scheduleActivityReload() {
  clearTimeout(activitySyncDebounce);
  activitySyncDebounce = setTimeout(() => void loadAndRenderActivity(), 400);
}

/** Same Range-header pagination as supabase.ts's fetchAllRows — a plain
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
    throw new Error(`Cannot mark applied: no registry record for "${entry.company} — ${entry.title}". This job was never canonicalized.`);
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
    throw new Error(`Cannot dismiss: "${entry.company} — ${entry.title}" already has an applied/failed outcome.`);
  }
  if (isDismissed(myState, entry)) {
    return; // already dismissed — no-op, matches SupabaseAdapter's own idempotent behavior
  }
  const reg = registryByJobId(myState.jobs, entry.job_id);
  if (!reg?.job_key) {
    throw new Error(`Cannot dismiss: no registry record for "${entry.company} — ${entry.title}".`);
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
  title.textContent = `${entry.company ?? ""} — ${entry.title ?? ""}`;
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
    empty.textContent = "No activity yet — once a search runs on your install, it'll show up here.";
    jobEventsList.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((event) => {
    const row = document.createElement("div");
    row.className = "activity-event";
    const label = document.createElement("span");
    label.textContent = `${event.status} — ${event.company ?? ""} ${event.title ?? ""}`.trim();
    const when = document.createElement("span");
    when.className = "activity-event-when";
    when.textContent = relativePostedAt(event.recorded_at) || "";
    row.append(label, when);
    fragment.appendChild(row);
  });
  jobEventsList.appendChild(fragment);
}

async function loadAndRenderActivity() {
  try {
    myState = await loadMyState();
  } catch {
    return; // transient fetch failure — next Realtime event or tab revisit retries
  }
  renderStats();
  renderReviewQueue();
  renderAppliedJobs();
  renderJobEvents();
}
