import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { RecommendedJob } from "../lib/bridge";
import "./RecommendedJobsMarquee.css";

// Always animates, at a duration scaled to card count rather than one
// fixed duration for every count: a fixed duration was the actual bug
// reported here: a real registry commonly turns up only 1-3 candidates,
// and a track that short covered by a duration tuned for ~12 cards moved
// so slowly it read as "completely static" even though it was technically
// animating.
const SECONDS_PER_CARD = 4;
const MIN_DURATION_S = 8;

// A group needs to be wider than the dashboard itself, or the gap between
// "last real card" and "loop point" shows as empty space mid-scroll before
// the repeat, exactly the "appears halfway" bug with only 1-2 real
// candidates. Padding each group up to this many cards (repeating the same
// real jobs, not fabricating new ones) guarantees enough width regardless
// of how few distinct recommendations there are.
const MIN_GROUP_SIZE = 6;

/** Repeats `jobs` (cycling through the same real list) until there are at
 *  least `minSize`, a no-op once the real list is already that long. */
function padJobs(jobs: RecommendedJob[], minSize: number): RecommendedJob[] {
  if (jobs.length === 0 || jobs.length >= minSize) return jobs;
  const padded: RecommendedJob[] = [];
  while (padded.length < minSize) padded.push(...jobs);
  return padded;
}

const COMPANY_SUFFIX_RE = /\b(?:incorporated|corporation|inc|corp|llc|ltd|co)\.?\b/gi;

/** Best-effort company domain guess for a logo lookup: the registry only
 *  has the ATS's own URL (jobs.ashbyhq.com/...), never the employer's real
 *  domain, so there's no authoritative source to read this from. Accepted,
 *  known-imperfect tradeoff (e.g. a guessed domain could belong to an
 *  unrelated business) in exchange for real logos on the common case;
 *  CompanyLogo's onError (and Google's own generic-globe fallback for an
 *  unknown domain) keep a wrong guess from ever looking broken. */
function guessCompanyDomain(company: string): string {
  const cleaned = company.toLowerCase().replace(COMPANY_SUFFIX_RE, "").replace(/[^a-z0-9]/g, "");
  return cleaned ? `${cleaned}.com` : "";
}

/** Deterministic per-company color (a cheap string hash -> hue) so the same
 *  company always gets the same initials-avatar color across renders and
 *  sessions, with no state to persist. */
function companyColor(company: string): string {
  let hash = 0;
  for (let i = 0; i < company.length; i++) {
    hash = (hash << 5) - hash + company.charCodeAt(i);
    hash |= 0;
  }
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

function CompanyLogo({ company }: { company: string }) {
  const [failed, setFailed] = useState(false);
  const domain = guessCompanyDomain(company);

  if (failed || !domain) {
    return (
      <span
        className="rec-job-card-logo rec-job-card-logo-fallback"
        style={{ backgroundColor: companyColor(company) }}
        aria-hidden="true"
      >
        {company.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }

  return (
    <img
      className="rec-job-card-logo"
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  );
}

function RecommendedJobCard({ job, hidden }: { job: RecommendedJob; hidden?: boolean }) {
  return (
    <button
      type="button"
      className="rec-job-card"
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : 0}
      onClick={() => void openUrl(job.apply_url || job.url)}
    >
      <div className="rec-job-card-header">
        <div className="rec-job-card-identity">
          <CompanyLogo company={job.company} />
          <span className="rec-job-card-company">{job.company}</span>
        </div>
        <span className="rec-job-card-match">{job.fit_score}% match</span>
      </div>
      <span className="rec-job-card-title">{job.title}</span>
      {job.matched_skills.length > 0 && (
        <div className="rec-job-card-quals-block">
          <span className="rec-job-card-quals-label">Skills matched</span>
          <ul className="rec-job-card-quals">
            {job.matched_skills.slice(0, 5).map((skill) => (
              <li key={skill}>
                <span className="rec-job-card-check" aria-hidden="true">
                  ✓
                </span>
                {skill}
              </li>
            ))}
          </ul>
        </div>
      )}
    </button>
  );
}

export function RecommendedJobsMarquee({ jobs }: { jobs: RecommendedJob[] }) {
  if (jobs.length === 0) return null;

  const paddedJobs = padJobs(jobs, MIN_GROUP_SIZE);
  const durationS = Math.max(MIN_DURATION_S, paddedJobs.length * SECONDS_PER_CARD);

  return (
    <section className="rec-jobs-marquee" aria-label="Recommended jobs to apply to next">
      <div className="rec-jobs-track" style={{ animationDuration: `${durationS}s` }}>
        <div className="rec-jobs-group">
          {paddedJobs.map((job, i) => (
            <RecommendedJobCard key={`${job.job_id}-${i}`} job={job} />
          ))}
        </div>
        <div className="rec-jobs-group" aria-hidden="true">
          {paddedJobs.map((job, i) => (
            <RecommendedJobCard key={`${job.job_id}-dup-${i}`} job={job} hidden />
          ))}
        </div>
      </div>
    </section>
  );
}
