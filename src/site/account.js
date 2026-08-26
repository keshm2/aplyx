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
  { source: "ashby", slugsKey: "ashby_company_slugs" },
  { source: "lever", slugsKey: "lever_company_slugs" },
  { source: "greenhouse", slugsKey: "greenhouse_company_slugs" },
  { source: "smartrecruiters", slugsKey: "smartrecruiters_company_slugs" },
];

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
}

function showSignedOut() {
  authPanel.hidden = false;
  dashboardPanel.hidden = true;
  searchResults.innerHTML = "";
  searchStatus.textContent = "";
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
 *  failing the whole search, same "degrade, don't break" contract. */
async function searchSource(source, companySlugs, query, titleWords, perCompanyLimit) {
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
        p_query: query,
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

function renderResults(rows) {
  searchResults.replaceChildren();
  if (rows.length === 0) {
    searchStatus.textContent = "No cached postings matched. Try a broader term, or install aplyx locally for a live, full-board search.";
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

    const company = document.createElement("span");
    company.className = "job-result-company";
    company.textContent = row.company ?? "";

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

    link.append(company, title, meta);
    fragment.appendChild(link);
  });
  searchResults.appendChild(fragment);
}

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = searchQuery.value.trim();
  const titleWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const perCompanyLimit = titleWords.length > 0 ? PER_COMPANY_LIMIT_SEARCH : PER_COMPANY_LIMIT_BROWSE;

  searchStatus.textContent = "Searching cached postings…";
  searchResults.innerHTML = "";

  const targets = await loadTargets().catch(() => undefined);
  if (!targets) {
    searchStatus.textContent = "Couldn't load the cached board list. Try again shortly.";
    return;
  }

  const resultsPerSource = await Promise.all(
    SOURCES.map(({ source, slugsKey }) =>
      searchSource(source, targets[slugsKey] || [], query, titleWords, perCompanyLimit),
    ),
  );
  const rows = resultsPerSource.flat();
  rows.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  renderResults(rows);
});
