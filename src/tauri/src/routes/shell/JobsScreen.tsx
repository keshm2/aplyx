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
import { findRoot, searchJobs, checkJobFit, saveJobForReview, readProfileField, triggerSingleJobApply } from "../../lib/bridge";
import { useAuth } from "../../lib/AuthContext";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { SkeletonRows } from "../../components/Skeleton";
import { ExternalLinkIcon } from "../../components/Icons";
import { Modal } from "../../components/Modal";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "../../components/Skeleton.css";

// Client-side pagination over whatever searchJobs() already returned
// (now up to MAX_PAGE_SIZE=300, see jobs.ts) — no re-fetch per page,
// just slicing the same in-memory, already-sorted result set. Default
// 25, user-adjustable and remembered across sessions (localStorage,
// same lightweight pattern uiPrefs.ts uses for theme/font — this is a
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
type SortMode = "preferred" | "recent" | "company" | "title";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "preferred", label: "Preferred location" },
  { value: "recent", label: "Recently posted" },
  { value: "company", label: "Company (A–Z)" },
  { value: "title", label: "Title (A–Z)" },
];

/** Rotated one at a time while a search is in flight — each one gets a
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
// own section instead of one flat run-on paragraph — the "how a job desc
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
// company logo — confirmed live, checked every field on a real response
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
// posting — without needing to replicate derive_job_id's URL-hash
// fallback client-side. A posting with no external_job_id just doesn't
// get a count lookup; that's an honest "unknown," not a wrong number.
function computeJobId(job: SearchJob): string | undefined {
  return job.external_job_id ? `${job.source}-${job.external_job_id}` : undefined;
}

export function JobsScreen() {
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
  // actually going out — every other button here (Check fit, Save to
  // review, even Dismiss elsewhere) fires immediately on a single click.
  const [applyArmed, setApplyArmed] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);
  const [preferredLocations, setPreferredLocations] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("preferred");
  // Toggle taken offline (see the comment near its removed button below) —
  // always false, never set, kept as a real variable rather than a bare
  // `false` literal so displayedJobs' filter branch is a one-line revert.
  const [preferredOnly] = useState(false);
  const [searchPhrase, setSearchPhrase] = useState(0);
  const [resultsPerPage, setResultsPerPage] = useState<number>(loadResultsPerPage);
  const [page, setPage] = useState(0);

  // Resolved once per screen session so repeated actions (search/fit/save)
  // don't re-await findRoot() — the bridge already caches at the module
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
  // instead of just a plain link — this is what actually runs that search
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
  // never drops a non-preferred posting — preferred_locations is a
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
  // search, sort change) or the page size itself changes — otherwise a
  // narrower re-search or a bigger page size could strand the view on a
  // now out-of-range page.
  useEffect(() => {
    setPage(0);
  }, [displayedJobs, resultsPerPage]);

  const totalPages = Math.max(1, Math.ceil(displayedJobs.length / resultsPerPage));
  const pageJobs = displayedJobs.slice(page * resultsPerPage, (page + 1) * resultsPerPage);

  // Global "N applied" counts — hosted-only (needs a signed-in Supabase
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
        // Best-effort social-proof signal — a fetch failure just means no
        // badges show this page, never an error the user needs to see.
        if (!cancelled) setApplyCounts({});
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, session, pageJobs]);

  const selectedJob = displayedJobs.find((j) => j.url === selected);
  const selectedFit = selectedJob ? fits[selectedJob.url] : undefined;
  const busy = searching || fitting || saving || applying;

  // Resets the arm state whenever the selected job changes, so "click
  // again to confirm" never carries over to a job the user didn't mean to
  // arm it for.
  useEffect(() => {
    setApplyArmed(undefined);
  }, [selected]);

  // Optional override so Home's quick-search can trigger a search with a
  // query it just set via setQuery() in the same tick — reading `query`
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
      // so dedup/sort/slice stay in one place — searchJobs — instead of
      // being forked client-side.
      //
      // Both phases are fired together, not awaited sequentially — each
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
        setMessage({ text: "No matching titles found — try a different query." });
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
        text: result === "saved" ? "Saved to review queue." : "Already saved — no duplicate recorded.",
      });
    } catch (err) {
      setMessage({ text: `Save failed: ${err instanceof Error ? err.message : String(err)}`, error: true });
    } finally {
      setSaving(false);
    }
  };

  // Requires a second click on the same job (see applyArmed above) before
  // it actually fires — this is the one action here that can end with a
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
          <label className="field-label" htmlFor="jobs-sort" style={{ fontWeight: 500 }}>
            Sort by
          </label>
          <select
            id="jobs-sort"
            className="themed-select"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {/* "Preferred locations only" toggle taken offline for now (operator
              request, 2026-07-23) — it was cutting real results out of an
              already-thin result set while search diversity/volume issues
              were being worked through. preferredOnly stays wired below
              (still always false, its default) so re-enabling this is just
              restoring the button. */}
          <label className="field-label" htmlFor="jobs-per-page" style={{ fontWeight: 500 }}>
            Results per page
          </label>
          <select
            id="jobs-per-page"
            className="themed-select"
            value={resultsPerPage}
            onChange={(e) => setResultsPerPage(Number(e.target.value))}
          >
            {RESULTS_PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
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
                  ? "No postings match “Preferred locations only” — turn it off to see everything again."
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
                          {job.company} — {job.title}
                        </span>
                        <span className="data-row-sub">
                          {SOURCE_LABEL[job.source]} · {job.location || "location not listed"}
                          {typeof applyCount === "number" && applyCount > 0
                            ? ` · ${applyCount} ${applyCount === 1 ? "person" : "people"} applied`
                            : ""}
                        </span>
                      </div>
                      {jobFit ? (
                        <span className={`status-badge ${fitBadgeClass(jobFit.fit_status)}`}>{jobFit.fit_score}</span>
                      ) : (
                        <span className="data-row-meta">{formatPosted(job.posted_at)}</span>
                      )}
                      {/* A real, generously-sized nested button — not just the
                          row's own double-click, which nothing on screen hints
                          at. Stops propagation so opening the posting never
                          also fires the row's own select handler. */}
                      <button
                        type="button"
                        className="data-row-open"
                        title={`Open ${job.company} — ${job.title}`}
                        aria-label={`Open ${job.company} — ${job.title}`}
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

      <Modal open={!!selectedJob} onClose={() => setSelected(undefined)} title={selectedJob ? `${selectedJob.company} — ${selectedJob.title}` : ""}>
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
            {/* Two equally-weighted primary paths — go look at the posting
                and apply by hand, or have aplyx do it — with "Check
                fit"/"Save to review" staying secondary to both, not equal
                with either. Full-size (no btn-sm) and first, same as
                Open always was. The aplyx path needs a second click on the
                same job to actually fire (applyArmed, reset whenever the
                selection changes) — the one action on this screen that can
                end with a real application actually going out, unlike Open
                (never submits anything itself) or the two secondary
                actions below (also never do). */}
            <button
              type="button"
              className="btn btn-primary detail-open-btn"
              disabled={busy}
              onClick={() => void open(selectedJob)}
            >
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
               *  (Ashby/Lever/Greenhouse/Workable reliably; SmartRecruiters/
               *  Oracle/Muse's feed don't have it) and never shown anywhere
               *  in the app until now — the fit-gate check already reads it,
               *  but a human never got to. Run through jobs.ts's htmlToText()
               *  at fetch time (converts <li> to "• " bullets, decodes HTML
               *  entities, marks section headings, collapses stray tags)
               *  rather than raw source markup, then renderJobDescription()
               *  below splits those "### " markers back out into their own
               *  labeled sections — no separate "requirements" field to
               *  pull out, postings don't structure that consistently
               *  enough to split deterministically beyond what each source
               *  itself already marked as a heading, so within a section it
               *  stays one block, same as a real job posting page reads. */}
            <hr className="detail-rule" />
            <div className="detail-row">
              <span className="detail-row-label">Full posting</span>
              {selectedJob.jd_text ? (
                // div, not p — base.css's global `p { max-width: 65ch }`
                // would clamp this to an oddly narrow ragged column
                // regardless of the modal's actual (wider) content width.
                <div className="detail-row-value" style={{ display: "block" }}>
                  {renderJobDescription(selectedJob.jd_text)}
                </div>
              ) : (
                <span className="detail-row-value" style={{ color: "var(--text-faint)" }}>
                  Not available for this source — open the posting to read the full description.
                </span>
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
