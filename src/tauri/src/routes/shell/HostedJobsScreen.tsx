import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SearchJob } from "@aplyx/core/jobsSort.js";
import { sortByPostedDesc, sortByCompanyAsc, sortByTitleAsc } from "@aplyx/core/jobsSort.js";
import {
  searchHostedJobCache,
  HOSTED_JOB_SOURCES,
  HOSTED_JOB_SOURCE_LABELS,
  type HostedJobSource,
} from "@aplyx/core/jobCacheHosted.js";
import { SkeletonRows } from "../../components/Skeleton";
import { Dropdown } from "../../components/Dropdown";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "../../components/Skeleton.css";

const RESULTS_PER_PAGE_KEY = "aplyx.jobs.resultsPerPage";
const RESULTS_PER_PAGE_OPTIONS = [10, 25, 50, 100, 200];
const DEFAULT_RESULTS_PER_PAGE = 25;

function loadResultsPerPage(): number {
  const raw = Number(localStorage.getItem(RESULTS_PER_PAGE_KEY));
  return RESULTS_PER_PAGE_OPTIONS.includes(raw) ? raw : DEFAULT_RESULTS_PER_PAGE;
}

type SortMode = "recent" | "company" | "title";
const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "recent", label: "Recently posted" },
  { value: "company", label: "Company (A–Z)" },
  { value: "title", label: "Title (A–Z)" },
];

function formatPosted(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Browse-only job search for a hosted-only session (signed in, no local
 * aplyx checkout). Runs the same cached Tier-0 search as aplyx.app's
 * dashboard (searchHostedJobCache: a plain RPC against the shared
 * job_cache project, no Python, no checkout). Results open in the
 * browser; fit-scoring, tailoring, saving to review, and applying all
 * need a local checkout and live on the local JobsScreen instead.
 */
export function HostedJobsScreen() {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [jobs, setJobs] = useState<SearchJob[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchedOnce, setSearchedOnce] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sourceFilter, setSourceFilter] = useState<HostedJobSource | "all">("all");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [resultsPerPage, setResultsPerPage] = useState<number>(loadResultsPerPage);
  const [page, setPage] = useState(0);

  const searchGen = useRef(0);

  useEffect(() => {
    localStorage.setItem(RESULTS_PER_PAGE_KEY, String(resultsPerPage));
  }, [resultsPerPage]);

  const runSearch = async (raw: string) => {
    const gen = ++searchGen.current;
    setSearching(true);
    setError(undefined);
    try {
      const results = await searchHostedJobCache(raw);
      if (gen !== searchGen.current) return;
      setJobs(results);
    } catch (err) {
      if (gen !== searchGen.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setJobs([]);
    } finally {
      if (gen === searchGen.current) {
        setSearching(false);
        setSearchedOnce(true);
      }
    }
  };

  // Browse everything on arrival, and honor Home's quick-search hand-off.
  useEffect(() => {
    const initial = (location.state as { initialQuery?: string } | null)?.initialQuery;
    if (initial && initial.trim()) {
      setQuery(initial);
      void runSearch(initial);
    } else {
      void runSearch("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const displayed = useMemo(() => {
    const base = sourceFilter === "all" ? jobs : jobs.filter((j) => j.source === sourceFilter);
    switch (sortMode) {
      case "company":
        return sortByCompanyAsc(base);
      case "title":
        return sortByTitleAsc(base);
      case "recent":
      default:
        return sortByPostedDesc(base);
    }
  }, [jobs, sourceFilter, sortMode]);

  useEffect(() => {
    setPage(0);
  }, [displayed, resultsPerPage]);

  const totalPages = Math.max(1, Math.ceil(displayed.length / resultsPerPage));
  const pageJobs = displayed.slice(page * resultsPerPage, (page + 1) * resultsPerPage);

  const open = (job: SearchJob) => {
    void openUrl(job.apply_url || job.url).catch((err) =>
      setError(`Could not open: ${err instanceof Error ? err.message : String(err)}`),
    );
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
              if (e.key === "Enter") void runSearch(query);
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
          <button type="button" className="btn btn-primary" disabled={searching} onClick={() => void runSearch(query)}>
            Search
          </button>
        </div>

        <div className="data-toolbar" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
          <button
            type="button"
            className={sourceFilter === "all" ? "btn btn-sm btn-primary" : "btn btn-sm"}
            onClick={() => setSourceFilter("all")}
          >
            All boards
          </button>
          {HOSTED_JOB_SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              className={sourceFilter === s ? "btn btn-sm btn-primary" : "btn btn-sm"}
              onClick={() => setSourceFilter(s)}
            >
              {HOSTED_JOB_SOURCE_LABELS[s]}
            </button>
          ))}
        </div>

        <div className="data-toolbar">
          <span className="field-label" style={{ fontWeight: 500 }}>
            Sort by
          </span>
          <div style={{ width: "11rem" }}>
            <Dropdown value={sortMode} onChange={setSortMode} label="Sort by" options={SORT_OPTIONS} />
          </div>
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

        <p className="field-help">
          A cached snapshot from Ashby, Lever, Greenhouse, and SmartRecruiters, refreshed a few times
          a week. For a live full-board search plus fit-scoring, tailoring, and applying, connect a
          local aplyx checkout in Settings.
        </p>
      </div>

      {error ? <div className="message-banner message-banner-error">{error}</div> : null}

      <div className="data-screen">
        <div className="data-list-col">
          {displayed.length === 0 ? (
            searching ? (
              <SkeletonRows count={6} />
            ) : (
              <div className="data-empty">
                {searchedOnce
                  ? "No cached postings matched. Try a broader title, or a different board."
                  : "Type a title and press Search to browse the cached boards."}
              </div>
            )
          ) : (
            <>
              <div className="data-list">
                {pageJobs.map((job) => (
                  <div
                    key={`${job.source}:${job.url}`}
                    role="button"
                    tabIndex={0}
                    className="data-row"
                    onClick={() => open(job)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(job);
                      }
                    }}
                  >
                    <div className="data-row-main">
                      <span className="data-row-title">
                        {job.company} - {job.title}
                      </span>
                      <span className="data-row-sub">
                        {HOSTED_JOB_SOURCE_LABELS[job.source as HostedJobSource] ?? job.source} ·{" "}
                        {job.location || "location not listed"}
                      </span>
                    </div>
                    <div className="data-row-side">
                      {job.pay_text ? <span className="data-row-pay">{job.pay_text.split(" · ")[0]}</span> : null}
                      <span className="data-row-meta">{formatPosted(job.posted_at)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {totalPages > 1 ? (
                <div className="data-toolbar" style={{ justifyContent: "space-between" }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    ← Previous
                  </button>
                  <span className="field-label">
                    Page {page + 1} of {totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  >
                    Next →
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
