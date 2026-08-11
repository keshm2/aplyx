import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JobSource, SearchJob, SearchResult, SourceResult, FitResult } from "@aplyx/core/jobs.js";
import {
  sortByPreferredThenPosted,
  sortByPostedDesc,
  sortByCompanyAsc,
  sortByTitleAsc,
  isPreferredLocation,
} from "@aplyx/core/jobsSort.js";
import { findRoot, searchJobs, checkJobFit, saveJobForReview, readProfileField } from "../../lib/bridge";
import { SkeletonRows } from "../../components/Skeleton";
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
};
const SOURCES: JobSource[] = ["ashbyhq", "lever", "greenhouse", "smartrecruiters", "workable", "amazon", "oracle", "workday", "muse"];

/** Pure fetch()-based sources (no Python subprocess startup) — shown first
 *  in a two-phase search so useful results appear before the slower
 *  Python-backed sources (Amazon/Oracle/Workday/The Muse) finish. */
const FAST_SOURCES: JobSource[] = ["ashbyhq", "lever", "greenhouse", "smartrecruiters", "workable"];
const SLOW_SOURCES: JobSource[] = ["amazon", "oracle", "workday", "muse"];

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

function sourceBadge(result: SourceResult | undefined, loading: boolean): { text: string; className: string } {
  if (loading) return { text: "loading…", className: "status-badge-muted" };
  if (!result) return { text: "–", className: "status-badge-muted" };
  if (result.state === "warning") return { text: result.detail ?? "warning", className: "status-badge-warn" };
  if (result.state === "skipped") return { text: "off", className: "status-badge-muted" };
  return { text: String(result.count), className: "status-badge-good" };
}

export function JobsScreen() {
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState<Record<JobSource, boolean>>({
    ashbyhq: true,
    lever: true,
    greenhouse: true,
    smartrecruiters: true,
    workable: true,
    amazon: true,
    oracle: true,
    workday: true,
    muse: true,
  });
  const [jobs, setJobs] = useState<SearchJob[]>([]);
  const [sources, setSources] = useState<Partial<Record<JobSource, SourceResult>>>({});
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [fits, setFits] = useState<Record<string, FitResult>>({});
  const [searching, setSearching] = useState(false);
  const [fitting, setFitting] = useState(false);
  const [saving, setSaving] = useState(false);
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

  const selectedJob = displayedJobs.find((j) => j.url === selected);
  const selectedFit = selectedJob ? fits[selectedJob.url] : undefined;
  const busy = searching || fitting || saving;

  const search = async () => {
    const gen = ++searchGen.current;
    setSearching(true);
    setMessage(undefined);
    const trim = query.trim();
    try {
      const root = await resolveRoot();
      const slowEnabled = SLOW_SOURCES.some((s) => enabled[s]);
      const fastEnabled = FAST_SOURCES.some((s) => enabled[s]);

      const apply = (result: SearchResult) => {
        if (gen !== searchGen.current) return;
        setJobs(result.jobs);
        setSources(result.sources);
        setSelected(undefined);
      };

      if (fastEnabled && slowEnabled) {
        // Two-phase: show fast-source (fetch-based) results immediately,
        // then replace with the complete set once the slower Python-backed
        // sources finish. Phase 2 re-fetches fast sources (cheap, bounded
        // by the bridge's per-source deadline) so dedup/sort/slice stay
        // in one place — searchJobs — instead of being forked client-side.
        //
        // Both phases are fired together, not awaited sequentially — each
        // is its own Tauri->Node subprocess spawn (no persistent bridge
        // daemon), so awaiting phase1 fully before even starting phase2
        // meant every search paid spawn+network cost twice, back to back,
        // and phase2's slow sources (Amazon/Oracle/Workday, up to a 2.2s
        // deadline each) didn't start counting until phase1 had already
        // finished. Firing concurrently keeps the exact same progressive
        // apply behavior (phase1's partial results still land first) but
        // caps total wait for the final render at max(phase1, phase2)
        // instead of phase1 + phase2.
        const fastOnly = { ...enabled, amazon: false, oracle: false, workday: false };
        const phase1Promise = searchJobs(root, trim, fastOnly);
        const phase2Promise = searchJobs(root, trim, enabled);
        const phase1 = await phase1Promise;
        if (gen !== searchGen.current) return;
        if (phase1.jobs.length > 0) apply(phase1);
        const phase2 = await phase2Promise;
        if (gen !== searchGen.current) return;
        apply(phase2);
        if (phase2.jobs.length === 0) {
          setMessage({ text: "No matching titles found — try a different query." });
        }
      } else {
        const result = await searchJobs(root, trim, enabled);
        if (gen !== searchGen.current) return;
        apply(result);
        if (result.jobs.length === 0) {
          setMessage({ text: "No matching titles found — try a different query." });
        }
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
          {SOURCES.map((source) => {
            const badge = sourceBadge(sources[source], searching && enabled[source]);
            return (
              <button
                key={source}
                type="button"
                className={enabled[source] ? "source-toggle on" : "source-toggle"}
                onClick={() => setEnabled((cur) => ({ ...cur, [source]: !cur[source] }))}
              >
                {SOURCE_LABEL[source]}
                <span className={`status-badge ${badge.className}`}>{badge.text}</span>
              </button>
            );
          })}
        </div>
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
                  return (
                    <button
                      key={job.url}
                      type="button"
                      className={job.url === selected ? "data-row selected" : "data-row"}
                      onClick={() => setSelected(job.url)}
                      onDoubleClick={() => void open(job)}
                    >
                      <div className="data-row-main">
                        <span className="data-row-title">
                          {job.company} — {job.title}
                        </span>
                        <span className="data-row-sub">
                          {SOURCE_LABEL[job.source]} · {job.location || "location not listed"}
                        </span>
                      </div>
                      {jobFit ? (
                        <span className={`status-badge ${fitBadgeClass(jobFit.fit_status)}`}>{jobFit.fit_score}</span>
                      ) : (
                        <span className="data-row-meta">{formatPosted(job.posted_at)}</span>
                      )}
                    </button>
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

        {selectedJob ? (
          <div className="detail-col">
            <div className="detail-title">{selectedJob.title}</div>
            <div className="detail-row">
              <span className="detail-row-label">Company</span>
              <span className="detail-row-value">{selectedJob.company}</span>
            </div>
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
            <div className="detail-actions">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void open(selectedJob)}>
                Open
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void fit(selectedJob)}>
                {fitting ? "Checking…" : "Check fit"}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => void save(selectedJob)}
              >
                {saving ? "Saving…" : "Save to review"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
