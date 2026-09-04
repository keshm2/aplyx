import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JobSource, SearchJob, SearchResult, FitResult } from "@aplyx/core/jobs.js";
import {
  sortByPreferredThenPosted,
  sortByPostedDesc,
  sortByCompanyAsc,
  sortByTitleAsc,
  isPreferredLocation,
} from "@aplyx/core/jobsSort.js";
import { findRoot, searchJobs, checkJobFit, checkJobFitBatch, fetchJobDescription, saveJobForReview, readProfileField, triggerSingleJobApply } from "../../lib/bridge";
import { useAuth } from "../../lib/AuthContext";
import { useAplyxState } from "../../lib/useAplyxState";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { HostedJobsScreen } from "./HostedJobsScreen";
import { SkeletonRows } from "../../components/Skeleton";
import { ExternalLinkIcon } from "../../components/Icons";
import { Modal } from "../../components/Modal";
import { Dropdown } from "../../components/Dropdown";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "../../components/Skeleton.css";

// Client-side pagination over whatever searchJobs() already returned
// (now up to MAX_PAGE_SIZE=300, see jobs.ts): no re-fetch per page,
// just slicing the same in-memory, already-sorted result set. Default
// 25, user-adjustable and remembered across sessions (localStorage,
// same lightweight pattern uiPrefs.ts uses for theme/font, this is a
// single-screen preference, not worth its own shared module).
const RESULTS_PER_PAGE_KEY = "aplyx.jobs.resultsPerPage";
const DEFAULT_RESULTS_PER_PAGE = 25;
const RESULTS_PER_PAGE_OPTIONS = [10, 25, 50, 100, 200];

function loadResultsPerPage(): number {
  const raw = Number(localStorage.getItem(RESULTS_PER_PAGE_KEY));
  return RESULTS_PER_PAGE_OPTIONS.includes(raw) ? raw : DEFAULT_RESULTS_PER_PAGE;
}

const SOURCE_LABEL: Record<JobSource, string> = {
  ashbyhq: "Ashby",
  lever: "Lever",
  greenhouse: "Greenhouse",
  smartrecruiters: "SmartRecruiters",
  workable: "Workable",
  amazon: "Amazon",
  oracle: "Oracle",
  workday: "Workday",
  muse: "The Muse",
  simplify: "SimplifyJobs",
  vanshb03: "vanshb03",
};
// Mirrors jobs.ts's JD_BACKFILL_SOURCES: these sources' list-mode fetch
// deliberately omits jd_text (it lives behind a second per-requisition API
// call the bulk board listing can't afford per posting), not because the
// posting genuinely has no description. Opening the detail view for one
// of these triggers that second call instead of showing a permanent
// "not available" for a JD that really does exist.
const JD_BACKFILL_SOURCES: ReadonlySet<JobSource> = new Set(["workday", "smartrecruiters", "oracle"]);

type SortMode = "preferred" | "recent" | "company" | "title";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "preferred", label: "Preferred location" },
  { value: "recent", label: "Recently posted" },
  { value: "company", label: "Company (A–Z)" },
  { value: "title", label: "Title (A–Z)" },
];

/** Rotated one at a time while a search is in flight: each one gets a
 *  fresh mount (keyed by index) so its fade-in/out CSS animation
 *  restarts, giving a continuous crossfade rather than a hard cut. */
const SEARCH_PHRASES = [
  "Finding your next job…",
  "Searching the boards…",
  "Scanning fresh postings…",
  "Matching your search…",
  "Almost there…",
];

function formatPosted(iso?: string): string {
  if (!iso) return "not listed";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not listed";
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function fitBadgeClass(status: FitResult["fit_status"]): string {
  if (status === "candidate") return "status-badge-good";
  if (status === "needs_review") return "status-badge-warn";
  return "status-badge-danger";
}

// Splits jd_text on the "### Heading" markers jobs.ts's htmlToText/
// markHeadings already inserted (own blank-line-delimited block, so
// splitting on "\n\n" cleanly isolates each one) and renders each as its
// own section instead of one flat run-on paragraph, the "how a job desc
// actually looks" ask. Reuses .section-label (already loaded via
// formFields.css below) rather than inventing a new heading style, same
// small-caps "here's a section" treatment Home/Status already use.
function renderJobDescription(text: string) {
  return text.split("\n\n").map((block, i) =>
    block.startsWith("### ") ? (
      <div key={i} className="section-label" style={{ marginTop: i === 0 ? 0 : "var(--space-4)" }}>
        {block.slice(4).trim()}
      </div>
    ) : (
      <div key={i} style={{ whiteSpace: "pre-wrap" }}>
        {block}
      </div>
    ),
  );
}

// No ATS API used here (Ashby/Lever/Greenhouse/Workable) returns a
// company logo, confirmed live, checked every field on a real response
// from each. Best-effort only: guesses "{company}.com" (company is
// already the literal board slug for 3 of 4 sources, so this lands right
// more often than a name-based guess would) and asks DuckDuckGo's public
// favicon proxy for it, which itself degrades gracefully (serves a
// generic icon rather than erroring on an unknown domain). CompanyLogo
// below adds one more layer on top for the cases even that misses:
// falls back to a plain initial on any load error, never a broken image
// or a logo for the wrong company.
function guessCompanyDomain(company: string): string | undefined {
  const normalized = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized ? `${normalized}.com` : undefined;
}

function CompanyLogo({ company }: { company: string }) {
  const domain = useMemo(() => guessCompanyDomain(company), [company]);
  const [failed, setFailed] = useState(false);
  if (!domain || failed) {
    return (
      <div className="data-row-logo data-row-logo-fallback" aria-hidden="true">
        {company.trim().charAt(0).toUpperCase() || "?"}
      </div>
    );
  }
  return (
    <img
      key={domain}
      src={`https://icons.duckduckgo.com/ip3/${domain}.ico`}
      alt=""
      aria-hidden="true"
      className="data-row-logo"
      onError={() => setFailed(true)}
    />
  );
}

// Matches job_state.py's derive_job_id()'s primary branch exactly
// ("{source}-{external_job_id}") so this lines up with the same job_id
// applied_jobs rows (and public.job_apply_counts) use for the same
// posting: without needing to replicate derive_job_id's URL-hash
// fallback client-side. A posting with no external_job_id just doesn't
// get a count lookup; that's an honest "unknown," not a wrong number.
function computeJobId(job: SearchJob): string | undefined {
  return job.external_job_id ? `${job.source}-${job.external_job_id}` : undefined;
}

// jobs.ts's extractPay/ashbyPayText join multiple location-tagged ranges
// with " · " when a posting states genuinely different pay per location
// (e.g. "$136K–$187K/yr (California) · $116K–$160K/yr (Canada)"): full
// detail belongs in the modal, where there's room, but the row itself is
// too narrow for that; this shows just the first range plus a "+N" count
// so the row stays compact while still signaling there's more to see.
function payTextSummary(payText: string): { primary: string; extraCount: number } {
  const parts = payText.split(" · ");
  return { primary: parts[0], extraCount: parts.length - 1 };
}

/**
 * Route entry: a local aplyx checkout drives the full search (fit-scoring,
 * tailoring, saving to review, applying); a hosted-only session (signed
 * in, no checkout) falls back to the browse-only cached search, same as
 * aplyx.app. Mirrors useAplyxState's local-wins-then-hosted precedence
 * used by every other pipeline screen.
 */
export function JobsScreen() {
  const { source, loaded } = useAplyxState();
  if (!loaded) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Jobs</h1>
        <SkeletonRows count={6} />
      </div>
    );
  }
  if (source === "hosted") return <HostedJobsScreen />;
  if (source === "none") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", maxWidth: "42rem" }}>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Jobs</h1>
        <p className="field-help">
          Sign in for a cached job search, or connect a local aplyx checkout in Settings for the full
          live search plus tailoring and applying.
        </p>
      </div>
    );
  }
  return <LocalJobsScreen />;
}

function LocalJobsScreen() {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [jobs, setJobs] = useState<SearchJob[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [fits, setFits] = useState<Record<string, FitResult>>({});
  const [searching, setSearching] = useState(false);
  const [fitting, setFitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  // Two-click confirm, keyed by job url so switching the selected job
  // always resets it rather than leaving a stale "click again to apply"
  // armed against a *different* job than the one now showing. This is
  // the one action in the whole app that can end with a real application
  // actually going out; every other button here (Check fit, Save to
  // review, even Dismiss elsewhere) fires immediately on a single click.
  const [applyArmed, setApplyArmed] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);
  const [preferredLocations, setPreferredLocations] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("preferred");
  // Toggle taken offline (see the comment near its removed button below):
  // always false, never set, kept as a real variable rather than a bare
  // `false` literal so displayedJobs' filter branch is a one-line revert.
  const [preferredOnly] = useState(false);
  const [searchPhrase, setSearchPhrase] = useState(0);
  const [resultsPerPage, setResultsPerPage] = useState<number>(loadResultsPerPage);
  const [page, setPage] = useState(0);

  // Resolved once per screen session so repeated actions (search/fit/save)
  // don't re-await findRoot(): the bridge already caches at the module
  // level, but this skips even the microtask hop and makes the intent local.
  const rootRef = useRef<string | undefined>(undefined);
  const resolveRoot = async (): Promise<string> => {
    if (rootRef.current) return rootRef.current;
    const root = await findRoot();
    rootRef.current = root;
    return root;
  };

  // Generation counter: each search bumps it; a result from an older
  // generation is discarded so a slow earlier search can't overwrite
  // newer results after a faster later one already landed.
  const searchGen = useRef(0);

  useEffect(() => {
    if (!searching) {
      setSearchPhrase(0);
      return;
    }
    const interval = setInterval(() => setSearchPhrase((i) => (i + 1) % SEARCH_PHRASES.length), 1800);
    return () => clearInterval(interval);
  }, [searching]);

  useEffect(() => {
    resolveRoot()
      .then((root) => readProfileField(root, "preferred_locations"))
      .then((value) => setPreferredLocations(Array.isArray(value) ? value : value ? [value] : []))
      .catch(() => setPreferredLocations([]));
  }, []);

  // Home's quick-search box navigates here with { state: { initialQuery } }
  // instead of just a plain link: this is what actually runs that search
  // on arrival instead of leaving the user to retype it. Only ever fires
  // once per navigation: location.state is fresh (undefined) on any normal
  // NavLink/nav-menu click, so there's nothing here to guard against
  // re-triggering on a later remount.
  useEffect(() => {
    const initial = (location.state as { initialQuery?: string } | null)?.initialQuery;
    if (initial && initial.trim()) {
      setQuery(initial);
      void search(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The bridge's searchJobs() already sorts preferred-location-first by
  // default (src/core/src/jobs.ts's sortByPreferredThenPosted) and
  // never drops a non-preferred posting: preferred_locations is a
  // priority list, not a filter. This just lets the user pick a different
  // ordering, or opt into an explicit "preferred only" filter, entirely
  // client-side against the same fetched results (no re-fetch needed).
  const displayedJobs = useMemo(() => {
    const base = preferredOnly ? jobs.filter((j) => isPreferredLocation(j, preferredLocations)) : jobs;
    switch (sortMode) {
      case "recent":
        return sortByPostedDesc(base);
      case "company":
        return sortByCompanyAsc(base);
      case "title":
        return sortByTitleAsc(base);
      case "preferred":
      default:
        return sortByPreferredThenPosted(base, preferredLocations);
    }
  }, [jobs, sortMode, preferredOnly, preferredLocations]);

  useEffect(() => {
    localStorage.setItem(RESULTS_PER_PAGE_KEY, String(resultsPerPage));
  }, [resultsPerPage]);

  // Back to page 1 whenever the underlying result set changes (new
  // search, sort change) or the page size itself changes: otherwise a
  // narrower re-search or a bigger page size could strand the view on a
  // now out-of-range page.
  useEffect(() => {
    setPage(0);
  }, [displayedJobs, resultsPerPage]);

  const totalPages = Math.max(1, Math.ceil(displayedJobs.length / resultsPerPage));
  // Memoized, not a plain .slice(): a fresh array every render was
  // exactly what made the applyCounts effect below refire on every
  // render (its dependency array saw a "new" pageJobs each time even
  // when nothing relevant changed), which triggered its own setState,
  // which triggered another render, forever. Confirmed live: "Maximum
  // update depth exceeded," caught before shipping.
  const pageJobs = useMemo(
    () => displayedJobs.slice(page * resultsPerPage, (page + 1) * resultsPerPage),
    [displayedJobs, page, resultsPerPage],
  );

  // Global "N applied" counts: hosted-only (needs a signed-in Supabase
  // session to read public.job_apply_counts at all), fetched once per
  // page as a single batched request, not one request per row.
  const { status: authStatus, session } = useAuth();
  const [applyCounts, setApplyCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (authStatus !== "signed-in" || !session) {
      setApplyCounts({});
      return;
    }
    const jobIds = [...new Set(pageJobs.map(computeJobId).filter((id): id is string => !!id))];
    if (jobIds.length === 0) {
      setApplyCounts({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const client = await getSupabaseClient();
        const counts = await new SupabaseAdapter(client, session.user.id).getApplyCounts(jobIds);
        if (!cancelled) setApplyCounts(counts);
      } catch {
        // Best-effort social-proof signal: a fetch failure just means no
        // badges show this page, never an error the user needs to see.
        if (!cancelled) setApplyCounts({});
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, session, pageJobs]);

  const rawSelectedJob = displayedJobs.find((j) => j.url === selected);

  // Backfilled jd_text/pay_text for sources whose list-mode fetch omits
  // them (see JD_BACKFILL_SOURCES), keyed by url so switching between
  // jobs never shows a stale fetch from a previously opened posting, and
  // a job already fetched this session doesn't re-fetch on reselect.
  const [jdBackfill, setJdBackfill] = useState<Record<string, { jd_text?: string; pay_text?: string; loading?: boolean; failed?: boolean }>>({});
  // Guards against firing the same job's fetch twice from two different
  // triggers (the prefetch effect below and the modal-open effect both
  // check jdBackfill first, but that's state: two effects can both read
  // "not present yet" in the same tick before either's setState commits).
  const jdFetchInFlight = useRef<Set<string>>(new Set());

  const backfillJd = async (job: SearchJob) => {
    const url = job.url;
    if (jdFetchInFlight.current.has(url)) return;
    jdFetchInFlight.current.add(url);
    setJdBackfill((prev) => ({ ...prev, [url]: { loading: true } }));
    try {
      const root = await resolveRoot();
      const result = await fetchJobDescription(root, job);
      setJdBackfill((prev) => ({ ...prev, [url]: { jd_text: result.jd_text, pay_text: result.pay_text } }));
    } catch {
      setJdBackfill((prev) => ({ ...prev, [url]: { failed: true } }));
    } finally {
      jdFetchInFlight.current.delete(url);
    }
  };

  // Prefetches the current page's Oracle/Workday/SmartRecruiters postings
  // in the background as soon as results land, instead of waiting for a
  // click into each one, so both the pay badge and the full description
  // are usually already there by the time a user opens a posting. Capped
  // concurrency (a handful of subprocess calls at once, not 25-200 all at
  // once) and scoped to just the visible page: changing page/query kicks
  // off a fresh batch for the newly visible jobs, and a job scrolled past
  // before its fetch lands just finishes into the cache for next time.
  const JD_PREFETCH_CONCURRENCY = 4;
  useEffect(() => {
    const candidates = pageJobs.filter(
      (job) =>
        JD_BACKFILL_SOURCES.has(job.source) &&
        !job.jd_text &&
        !jdBackfill[job.url] &&
        !jdFetchInFlight.current.has(job.url),
    );
    if (candidates.length === 0) return;
    let cancelled = false;
    let next = 0;
    const worker = async () => {
      while (!cancelled && next < candidates.length) {
        const job = candidates[next++]!;
        await backfillJd(job);
      }
    };
    void Promise.all(Array.from({ length: Math.min(JD_PREFETCH_CONCURRENCY, candidates.length) }, worker));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageJobs]);

  // Runs the fit gate automatically for the current page, instead of
  // requiring a "Check fit" click per row, so a user can scan a page of
  // results and immediately see which are worth opening. Deliberately
  // excludes JD_BACKFILL_SOURCES: those need a live network fetch per
  // posting first (see backfillJd above), which is fine for one manual
  // click but not for auto-running across a whole page of results;
  // the fit gate itself is a cheap, local, deterministic script (2
  // subprocess spawns for the whole page via checkJobFitBatch, not one
  // per job) with nothing to rate-limit against, so there's no similar
  // concern for the sources this does cover.
  useEffect(() => {
    const candidates = pageJobs.filter((job) => !JD_BACKFILL_SOURCES.has(job.source) && !fits[job.url]);
    if (candidates.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const root = await resolveRoot();
        const results = await checkJobFitBatch(root, candidates);
        if (cancelled) return;
        setFits((cur) => ({ ...cur, ...results }));
      } catch {
        // Best-effort: a batch failure just means those rows keep
        // showing "Check fit" instead of a badge, same as today.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageJobs]);

  // Covers the case a posting is opened before its prefetch got to it
  // (e.g. clicked immediately after results load): backfillJd's own
  // in-flight guard means this never duplicates a prefetch already running.
  useEffect(() => {
    if (!rawSelectedJob) return;
    if (!JD_BACKFILL_SOURCES.has(rawSelectedJob.source)) return;
    if (rawSelectedJob.jd_text) return;
    if (jdBackfill[rawSelectedJob.url]) return;
    void backfillJd(rawSelectedJob);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSelectedJob?.url]);

  const selectedBackfill = rawSelectedJob ? jdBackfill[rawSelectedJob.url] : undefined;
  const selectedJob = rawSelectedJob
    ? {
        ...rawSelectedJob,
        jd_text: rawSelectedJob.jd_text || selectedBackfill?.jd_text,
        pay_text: rawSelectedJob.pay_text || selectedBackfill?.pay_text,
      }
    : undefined;
  const selectedFit = selectedJob ? fits[selectedJob.url] : undefined;
  const busy = searching || fitting || saving || applying;

  // Resets the arm state whenever the selected job changes, so "click
  // again to confirm" never carries over to a job the user didn't mean to
  // arm it for.
  useEffect(() => {
    setApplyArmed(undefined);
  }, [selected]);

  // Optional override so Home's quick-search can trigger a search with a
  // query it just set via setQuery() in the same tick: reading `query`
  // itself here would still see the pre-update value (React state updates
  // aren't synchronous), so the caller passes the query straight through.
  const search = async (queryOverride?: string) => {
    const gen = ++searchGen.current;
    setSearching(true);
    setMessage(undefined);
    const trim = (queryOverride ?? query).trim();
    try {
      const root = await resolveRoot();

      const apply = (result: SearchResult) => {
        if (gen !== searchGen.current) return;
        setJobs(result.jobs);
        setSelected(undefined);
      };

      // Two-phase: show fast-source (fetch-based) results immediately,
      // then replace with the complete set once the slower Python-backed
      // sources (Amazon/Oracle/Workday) finish. Phase 2 re-fetches fast
      // sources too (cheap, bounded by the bridge's per-source deadline)
      // so dedup/sort/slice stay in one place (searchJobs) instead of
      // being forked client-side.
      //
      // Both phases are fired together, not awaited sequentially: each
      // is its own Tauri->Node subprocess spawn (no persistent bridge
      // daemon), so awaiting phase1 fully before even starting phase2
      // meant every search paid spawn+network cost twice, back to back,
      // and phase2's slow sources (up to a 2.2s deadline each) didn't
      // start counting until phase1 had already finished. Firing
      // concurrently keeps the exact same progressive apply behavior
      // (phase1's partial results still land first) but caps total wait
      // for the final render at max(phase1, phase2) instead of
      // phase1 + phase2.
      const fastOnly = { amazon: false, oracle: false, workday: false };
      const phase1Promise = searchJobs(root, trim, fastOnly);
      const phase2Promise = searchJobs(root, trim);
      const phase1 = await phase1Promise;
      if (gen !== searchGen.current) return;
      if (phase1.jobs.length > 0) apply(phase1);
      const phase2 = await phase2Promise;
      if (gen !== searchGen.current) return;
      apply(phase2);
      if (phase2.jobs.length === 0) {
        setMessage({ text: "No matching titles found. Try a different query." });
      }
    } catch (err) {
      if (gen !== searchGen.current) return;
      setMessage({ text: `Search failed: ${err instanceof Error ? err.message : String(err)}`, error: true });
    } finally {
      if (gen === searchGen.current) setSearching(false);
    }
  };

  const fit = async (job: SearchJob) => {
    setFitting(true);
    try {
      const root = await resolveRoot();
      const result = await checkJobFit(root, job);
      setFits((cur) => ({ ...cur, [job.url]: result }));
    } catch (err) {
      setMessage({ text: `Fit check failed: ${err instanceof Error ? err.message : String(err)}`, error: true });
    } finally {
      setFitting(false);
    }
  };

  const save = async (job: SearchJob) => {
    setSaving(true);
    try {
      const root = await resolveRoot();
      const result = await saveJobForReview(root, job);
      setMessage({
        text: result === "saved" ? "Saved to review queue." : "Already saved, no duplicate recorded.",
      });
    } catch (err) {
      setMessage({ text: `Save failed: ${err instanceof Error ? err.message : String(err)}`, error: true });
    } finally {
      setSaving(false);
    }
  };

  // Requires a second click on the same job (see applyArmed above) before
  // it actually fires: this is the one action here that can end with a
  // real application going out, so it doesn't get a single-click trigger
  // the way Check fit/Save to review do.
  const applyWithAplyx = async (job: SearchJob) => {
    if (applyArmed !== job.url) {
      setApplyArmed(job.url);
      return;
    }
    setApplyArmed(undefined);
    setApplying(true);
    try {
      const root = await resolveRoot();
      const result = await triggerSingleJobApply(root, {
        company: job.company,
        title: job.title,
        url: job.apply_url || job.url,
        source: job.source,
      });
      setMessage({ text: result.message, error: !result.ok });
    } catch (err) {
      setMessage({ text: `Couldn't start: ${err instanceof Error ? err.message : String(err)}`, error: true });
    } finally {
      setApplying(false);
    }
  };

  const open = async (job: SearchJob) => {
    try {
      await openUrl(job.apply_url || job.url);
    } catch (err) {
      setMessage({ text: `Could not open: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Jobs</h1>
        <div className="data-toolbar">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
            placeholder="type a job title, e.g. software engineer intern"
            style={{
              flex: 1,
              minWidth: "16rem",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-md)",
              padding: "var(--space-2) var(--space-3)",
              background: "var(--surface)",
              color: "var(--text)",
            }}
          />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void search()}>
            Search
          </button>
        </div>
        {searching ? (
          <div className="search-loading">
            <span className="search-spinner" aria-hidden="true" />
            <span key={searchPhrase} className="search-loading-text">
              {SEARCH_PHRASES[searchPhrase]}
            </span>
          </div>
        ) : null}
        <div className="data-toolbar">
          <span className="field-label" style={{ fontWeight: 500 }}>
            Sort by
          </span>
          {/* Native <select> replaced with the shared Dropdown component
             *  (operator report, 2026-08-22): Tauri's macOS webview is
             *  WebKit, not Chromium, and WebKit has its own well-known
             *  <select> hit-region quirks with a styled/appearance:none
             *  control: the visible box and the actual clickable area
             *  drifted apart, needing the mouse held slightly above the
             *  rendered text. Not reproducible in Chrome-based tooling,
             *  so rather than keep guessing at native-select CSS, this
             *  swaps to Dropdown: a fully custom-rendered, self-hit-tested
             *  listbox already used identically in Settings (Theme
             *  family/Font pickers), sidestepping the native control
             *  entirely instead of fighting its layout quirks. */}
          <div style={{ width: "11rem" }}>
            <Dropdown value={sortMode} onChange={setSortMode} label="Sort by" options={SORT_OPTIONS} />
          </div>
          {/* "Preferred locations only" toggle taken offline for now (operator
              request, 2026-07-23): it was cutting real results out of an
              already-thin result set while search diversity/volume issues
              were being worked through. preferredOnly stays wired below
              (still always false, its default) so re-enabling this is just
              restoring the button. */}
          <span className="field-label" style={{ fontWeight: 500 }}>
            Results per page
          </span>
          <div style={{ width: "6rem" }}>
            <Dropdown
              value={String(resultsPerPage)}
              onChange={(v) => setResultsPerPage(Number(v))}
              label="Results per page"
              options={RESULTS_PER_PAGE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>
        </div>
      </div>

      {message ? (
        <div className={message.error ? "message-banner message-banner-error" : "message-banner"}>{message.text}</div>
      ) : null}

      <div className="data-screen">
        <div className="data-list-col">
          {displayedJobs.length === 0 ? (
            searching ? (
              <SkeletonRows count={6} />
            ) : (
              <div className="data-empty">
                {jobs.length > 0
                  ? "No postings match “Preferred locations only”: turn it off to see everything again."
                  : "Type a title query and press Search to browse the live boards."}
              </div>
            )
          ) : (
            <>
              <div className="data-list">
                {pageJobs.map((job) => {
                  const jobFit = fits[job.url];
                  const jobId = computeJobId(job);
                  const applyCount = jobId ? applyCounts[jobId] : undefined;
                  const backfill = jdBackfill[job.url];
                  const payText = job.pay_text || backfill?.pay_text;
                  return (
                    <div
                      key={job.url}
                      role="button"
                      tabIndex={0}
                      className={job.url === selected ? "data-row selected" : "data-row"}
                      onClick={() => setSelected(job.url)}
                      onDoubleClick={() => void open(job)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(job.url);
                        }
                      }}
                    >
                      <CompanyLogo company={job.company} />
                      <div className="data-row-main">
                        <span className="data-row-title">
                          {job.company} - {job.title}
                        </span>
                        <span className="data-row-sub">
                          {SOURCE_LABEL[job.source]} · {job.location || "location not listed"}
                          {typeof applyCount === "number" && applyCount > 0
                            ? ` · ${applyCount} ${applyCount === 1 ? "person" : "people"} applied`
                            : ""}
                        </span>
                      </div>
                      <div className="data-row-side">
                        {payText ? (
                          (() => {
                            const { primary, extraCount } = payTextSummary(payText);
                            return (
                              <span className="data-row-pay">
                                {primary}
                                {extraCount > 0 ? ` +${extraCount}` : ""}
                              </span>
                            );
                          })()
                        ) : backfill?.loading ? (
                          <span className="data-row-meta">Looking…</span>
                        ) : (
                          // Explicit "we looked and found nothing" rather than
                          // silently leaving this slot blank: an empty gap
                          // reads as "still loading" or a rendering bug, not
                          // "extractPay/ashbyPayText genuinely found no pay
                          // info in this posting" (operator report, 2026-08-23).
                          <span className="data-row-meta">Couldn't find pay</span>
                        )}
                        {jobFit ? (
                          <span className={`status-badge ${fitBadgeClass(jobFit.fit_status)}`}>{jobFit.fit_score}</span>
                        ) : (
                          <span className="data-row-meta">{formatPosted(job.posted_at)}</span>
                        )}
                      </div>
                      {/* A real, generously-sized nested button, not just the
                          row's own double-click, which nothing on screen hints
                          at. Stops propagation so opening the posting never
                          also fires the row's own select handler. */}
                      <button
                        type="button"
                        className="data-row-open"
                        title={`Open ${job.company} - ${job.title}`}
                        aria-label={`Open ${job.company} - ${job.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void open(job);
                        }}
                      >
                        <ExternalLinkIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
              {totalPages > 1 ? (
                <div className="data-toolbar" style={{ justifyContent: "space-between" }}>
                  <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                    ← Previous
                  </button>
                  <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                    Page {page + 1} of {totalPages} · {displayedJobs.length} results
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next →
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>

      </div>

      <Modal open={!!selectedJob} onClose={() => setSelected(undefined)} title={selectedJob ? `${selectedJob.company} - ${selectedJob.title}` : ""}>
        {selectedJob && (
          <>
            <div className="detail-row">
              <span className="detail-row-label">Source</span>
              <span className="detail-row-value">{SOURCE_LABEL[selectedJob.source]}</span>
            </div>
            <div className="detail-row">
              <span className="detail-row-label">Location</span>
              <span className="detail-row-value">{selectedJob.location || "not listed"}</span>
            </div>
            <div className="detail-row">
              <span className="detail-row-label">Pay</span>
              {selectedJob.pay_text ? (
                <span className="detail-row-value" style={{ color: "var(--good)", fontWeight: 600 }}>
                  {selectedJob.pay_text}
                </span>
              ) : selectedBackfill?.loading ? (
                <span className="detail-row-value" style={{ color: "var(--text-faint)" }}>
                  Looking…
                </span>
              ) : (
                <span className="detail-row-value" style={{ color: "var(--text-faint)" }}>
                  Couldn't find pay
                </span>
              )}
            </div>
            <div className="detail-row">
              <span className="detail-row-label">Posted</span>
              <span className="detail-row-value">{formatPosted(selectedJob.posted_at)}</span>
            </div>
            <hr className="detail-rule" />
            <div className="detail-row">
              <span className="detail-row-label">Fit gate</span>
              {selectedFit ? (
                <>
                  <span className={`status-badge ${fitBadgeClass(selectedFit.fit_status)}`} style={{ alignSelf: "flex-start", marginTop: "0.25rem" }}>
                    {selectedFit.fit_status} · {selectedFit.fit_score}
                  </span>
                  <span className="detail-row-value" style={{ marginTop: "var(--space-2)" }}>
                    {selectedFit.reasoning}
                  </span>
                </>
              ) : (
                <span className="detail-row-value" style={{ color: "var(--text-faint)" }}>
                  Not run yet.
                </span>
              )}
            </div>
            <hr className="detail-rule" />
            {/* Apply with aplyx is the one action on this screen that can
                end with a real application actually going out (needs a
                second click on the same job to actually fire: applyArmed,
                reset whenever the selection changes), it stays the sole
                btn-primary (gradient-filled) so it visually reads as THE
                main path. Open posting demoted to the plain/outline .btn
                style (operator call, 2026-08-22: make it "less intriguing
                to click" than Apply, not equal to it): it never submits
                anything itself, same secondary weight as "Check fit"/"Save
                to review" below, just first in reading order since you
                often want to glance at the real posting before doing
                anything else. */}
            <button type="button" className="btn detail-open-btn" disabled={busy} onClick={() => void open(selectedJob)}>
              <ExternalLinkIcon />
              Open posting
            </button>
            <button
              type="button"
              className={applyArmed === selectedJob.url ? "btn btn-danger detail-open-btn" : "btn btn-primary detail-open-btn"}
              disabled={busy}
              onClick={() => void applyWithAplyx(selectedJob)}
            >
              {applying ? "Starting…" : applyArmed === selectedJob.url ? "Click again to confirm" : "Apply with aplyx"}
            </button>
            <div className="detail-actions">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void fit(selectedJob)}>
                {fitting ? "Checking…" : "Check fit"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void save(selectedJob)}
              >
                {saving ? "Saving…" : "Save to review"}
              </button>
            </div>

            {/* jd_text was already fetched by the scraper for most sources
               *  (Ashby/Lever/Greenhouse/Workable/Amazon/Muse) and never
               *  shown anywhere in the app until now: the fit-gate check
               *  already reads it, but a human never got to. Workday/
               *  SmartRecruiters/Oracle's list feed omits jd_text (it's
               *  behind a second per-requisition API call, not genuinely
               *  missing); the useEffect above backfills it lazily via
               *  fetchJobDescription() the moment this modal opens for one
               *  of those, same call checkJobFit already makes before
               *  evaluating fit. Run through jobs.ts's htmlToText() at
               *  fetch time (converts <li> to "• " bullets, decodes HTML
               *  entities, marks section headings, collapses stray tags)
               *  rather than raw source markup, then renderJobDescription()
               *  below splits those "### " markers back out into their own
               *  labeled sections: no separate "requirements" field to
               *  pull out, postings don't structure that consistently
               *  enough to split deterministically beyond what each source
               *  itself already marked as a heading, so within a section it
               *  stays one block, same as a real job posting page reads. */}
            <hr className="detail-rule" />
            <div className="detail-row">
              <span className="detail-row-label">Full posting</span>
              {selectedJob.jd_text ? (
                // div, not p: base.css's global `p { max-width: 65ch }`
                // would clamp this to an oddly narrow ragged column
                // regardless of the modal's actual (wider) content width.
                <div className="detail-row-value" style={{ display: "block" }}>
                  {renderJobDescription(selectedJob.jd_text)}
                </div>
              ) : selectedBackfill?.loading ? (
                <span className="detail-row-value" style={{ color: "var(--text-faint)" }}>
                  Fetching the full description…
                </span>
              ) : selectedBackfill?.failed ? (
                <span className="detail-row-value" style={{ color: "var(--text-faint)" }}>
                  Couldn't load the full description. Open the posting to read it directly.
                </span>
              ) : (
                <span className="detail-row-value" style={{ color: "var(--text-faint)" }}>
                  Not available for this source. Open the posting to read the full description.
                </span>
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
