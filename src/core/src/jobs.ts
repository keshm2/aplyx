import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { py, execFileWithStdin } from "./platform.js";
import { effectiveEnv, readTargetsArrayList } from "./settings.js";
import { sortByPreferredThenPosted, titleMatchesQuery, dedupeKey } from "./jobsSort.js";
import type { JobSource, SearchJob } from "./jobsSort.js";
import { readJobCache, sharedCacheSlugs } from "./jobCache.js";

export * from "./jobsSort.js";

const execFileAsync = promisify(execFile);
// Per-attempt socket timeout for the raw fetch()-based sources
// (Ashby/Lever/Greenhouse/SmartRecruiters). Previously 15s, which with
// the one-retry-on-failure logic below meant a single hung board could
// take up to 30s before failing. 6s per attempt still comfortably covers
// a real slow response; SOURCE_DEADLINE_MS below is the actual backstop
// against a whole search hanging regardless of this value.
const FETCH_TIMEOUT_MS = 6_000;
// Hard per-source ceiling for the whole manual search — no single board
// (however slow, hung, or misbehaving) can push the overall search past
// this, because every source promise is raced against it. Measured live
// that process/IPC overhead beyond the deadline itself varies (~150-450ms
// across repeated runs), so this is set with real margin under the ~3s
// target rather than right at the edge — worst case (a source actually
// hits the deadline) lands around 2.5-2.7s total. Oracle's Fusion HCM API
// is the slowest normal source at ~1.9-2.3s, so it will occasionally get
// cut off here even when it would have succeeded a bit slower than usual
// — an accepted tradeoff for a hard responsiveness guarantee: a cut-off
// source just shows "timed out", it doesn't fail or slow down the rest of
// the search. Requires bridge.ts to exit the process right after writing
// its result (see main()) — otherwise an abandoned slow fetch would keep
// the Node subprocess alive and the Rust caller blocked on it regardless
// of this race "winning" on the JS side.
const SOURCE_DEADLINE_MS = 2_200;
// Amazon/Oracle/Workday/Muse pay for a python3 process spawn plus a live
// network round trip on top of that — cost a fetch()-based source (Ashby/
// Lever/Greenhouse/SmartRecruiters) never has. Measured live with this
// file's own real args (LIVE_SOURCE_FETCH_LIMIT=75, --timeout 8): Oracle
// and Workday alone routinely take ~2.4-2.9s, already past
// SOURCE_DEADLINE_MS before adding this race's own ~150-450ms IPC
// overhead — not the "occasional" slow case the shared 2.2s deadline was
// tuned for, but nearly every run, so Oracle/Workday showed "timed out"
// almost always instead of actually finishing. These four get their own,
// more generous deadline instead of racing against the tighter budget
// meant for the cheaper in-process sources.
const PYTHON_SOURCE_DEADLINE_MS = 5_000;

/** Races a source fetch against a hard deadline; a slow/hung source
 *  degrades to a "timed out" warning instead of blocking the rest of the
 *  search. Does not cancel the underlying request (a fetch() or spawned
 *  Python process may keep running briefly in the background) — it just
 *  stops waiting on it, which is why bridge.ts must hard-exit right after
 *  printing the result rather than letting the process idle until every
 *  promise settles naturally. */
function withDeadline(
  promise: Promise<{ jobs: SearchJob[]; source: SourceResult }>,
  label: string,
  deadlineMs: number = SOURCE_DEADLINE_MS,
): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  return Promise.race([
    promise,
    new Promise<{ jobs: SearchJob[]; source: SourceResult }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ jobs: [], source: { state: "warning", count: 0, detail: `${label} timed out` } }),
        deadlineMs,
      );
      timer.unref?.();
    }),
  ]);
}
// User-configurable via Settings > Environment > "Max search results"
// (APLYX_JOBS_PER_PAGE) — how many results one manual search keeps
// (matched-and-sorted total, not a UI page — client-side pagination in
// the TUI's SearchScreen and the desktop app's JobsScreen slices this
// same returned set into pages, default 25/page, entirely separately;
// see each screen's own page-size constant).
//
// Raised twice on 2026-07-23: 75 -> 300/50 -> 100 when pagination was
// added, then 300 -> 2000/100 -> 500 after confirming live that 100 was
// STILL silently dropping most of what pagination was built to surface
// — a plain "engineer" search had 1,123 real matched postings
// (380 ashbyhq + 63 lever + 527 greenhouse + 9 smartrecruiters + 91
// amazon + 53 oracle, all counted from the full `matched` array before
// this slice), but the old 100 cap meant pagination only ever had 100
// of those to page through, no matter how many pages it offered. This
// value is what actually determines whether "everything" is shown —
// UI pagination just makes a bigger number here navigable instead of
// an unscrollable wall of results, it was never the thing limiting the
// total in the first place. Keeping more costs nothing extra for
// Ashby/Lever/Greenhouse/SmartRecruiters/cache (no additional network
// work, just less truncation of an already-fetched-and-matched array)
// — it DOES mean a bigger live query for Amazon/Oracle/Workday, which
// take this same number as their own fetch limit (see fetchAmazon/
// fetchOracle/fetchWorkday below), bounded by each source's own
// PYTHON_SOURCE_DEADLINE_MS regardless. 2000 is a safety ceiling against
// truly pathological cases (a one-word query against many configured
// companies), not a value real usage should often reach.
export const MIN_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 2000;
export const DEFAULT_PAGE_SIZE = 500;

// Deliberately NOT the same number as pageSize above, despite both being
// "how many jobs" limits — found live, right after the DEFAULT_PAGE_SIZE
// bump: fetchAmazon/fetchOracle/fetchWorkday take pageSize as their own
// `--limit` argument to the live Python fetch, and asking Amazon/Oracle
// for 500 within a fixed deadline regularly blew it and turned a working
// source into "timed out, 0 results" —
// a regression, not an improvement. pageSize governs how much of an
// already-fetched-and-matched batch searchJobs() keeps (free to raise —
// see its own comment); this governs how much these three specifically
// ask their live API for up front (not free — bounded by real network/
// processing time within one fixed deadline). 75 matches the old
// MAX_PAGE_SIZE ceiling these three were already proven to work
// reliably under.
const LIVE_SOURCE_FETCH_LIMIT = 75;

// The actual UI pagination size (results shown per page, both the TUI's
// SearchScreen and the desktop app's JobsScreen — see each's own
// resultsPerPage/RESULTS_PER_PAGE state). Purely a display concern, never
// passed to searchJobs() — kept here anyway, alongside the above, so
// every "how many jobs" tunable lives in one place and the TUI's
// SettingsScreen can import it the same way it already imports
// MIN/MAX/DEFAULT_PAGE_SIZE.
export const MIN_RESULTS_PER_PAGE = 5;
export const MAX_RESULTS_PER_PAGE = MAX_PAGE_SIZE;
export const DEFAULT_RESULTS_PER_PAGE = 25;

function resolvePageSize(root: string): number {
  const raw = Number.parseInt(effectiveEnv(root, ["APLYX_JOBS_PER_PAGE", "FLUX_JOBS_PER_PAGE"], String(DEFAULT_PAGE_SIZE)).value, 10);
  if (!Number.isFinite(raw)) return DEFAULT_PAGE_SIZE;
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, raw));
}

/** The TUI's own reader for its Settings > Environment > "Results per
 *  page" field (APLYX_RESULTS_PER_PAGE) — the desktop app doesn't call
 *  this, it persists the same concept via localStorage instead (see
 *  src/tauri/src/routes/shell/JobsScreen.tsx). */
export function resolveResultsPerPage(root: string): number {
  const raw = Number.parseInt(effectiveEnv(root, ["APLYX_RESULTS_PER_PAGE"], String(DEFAULT_RESULTS_PER_PAGE)).value, 10);
  if (!Number.isFinite(raw)) return DEFAULT_RESULTS_PER_PAGE;
  return Math.max(MIN_RESULTS_PER_PAGE, Math.min(MAX_RESULTS_PER_PAGE, raw));
}

export interface SourceResult {
  state: "ready" | "warning" | "skipped";
  count: number;
  detail?: string;
}

export interface SearchResult {
  jobs: SearchJob[];
  sources: Record<JobSource, SourceResult>;
}

export interface FitResult {
  fit_status: "candidate" | "needs_review" | "skipped_unfit";
  fit_score: number;
  reasoning: string;
  matched_skills?: string[];
}

export interface RecommendedJob {
  job_id: string;
  company: string;
  title: string;
  url: string;
  apply_url?: string;
  source?: string;
  role_type?: string;
  location_tier?: string;
  fit_score: number;
  matched_skills: string[];
}

interface RegistryFitCandidate extends SearchJob {
  job_key: string;
  job_id: string;
  location_tier?: string;
  internship_term?: string;
  role_type?: string;
  normalized_apply_url?: string;
  closed?: boolean;
}

export interface Targets {
  ashby_company_slugs?: string[];
  lever_company_slugs?: string[];
  greenhouse_company_slugs?: string[];
  smartrecruiters_company_slugs?: string[];
  workable_company_slugs?: string[];
  preferred_locations?: string[];
}

interface CanonicalJob extends SearchJob {
  job_key: string;
  job_id: string;
  location_tier?: string;
  internship_term?: string;
}

export interface SchedulerHeartbeat {
  last_run_completed_at: string;
  last_run_exit_code: number;
  last_run_counts: { applied: number; needs_review: number; failed: number; skipped_unfit: number };
  run_counter: number;
  consecutive_nonzero_exits: number;
}

export interface SchedulerStatus {
  installed: boolean;
  supported: boolean;
  interval_min: number;
  heartbeat: SchedulerHeartbeat | null;
}

/** Local 30-min scheduler state for the Home dashboard's status widget —
 *  installed/not, and the last completed run's heartbeat (see
 *  write_heartbeat.py). scheduler.py's own `status --json` already returns
 *  exactly this shape as one JSON line, so runPyJson's single-parse works
 *  here (unlike evaluate_job_fit.py --batch's JSONL output). */
export async function getSchedulerStatus(root: string): Promise<SchedulerStatus> {
  return await runPyJson(root, ["src/scripts/runtime/scheduler.py", "status", "--json"]) as SchedulerStatus;
}

/** Toggle the local 30-min scheduler on/off (install/uninstall the launchd
 *  agent — see scheduler.py's own install/uninstall for what that actually
 *  does per OS). install/uninstall print plain human-readable text, not
 *  JSON, so this doesn't go through runPyJson — it just runs the command
 *  (execFileAsync rejects on a non-zero exit) and returns fresh status
 *  once it's done, so the caller always gets the post-toggle truth rather
 *  than having to separately re-fetch. */
export async function setSchedulerInstalled(root: string, installed: boolean): Promise<SchedulerStatus> {
  const p = py(["src/scripts/runtime/scheduler.py", installed ? "install" : "uninstall"]);
  await execFileAsync(p.cmd, p.args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  return getSchedulerStatus(root);
}

export function configured(values: string[] | undefined): string[] {
  return (values ?? []).filter((value) => value && value !== "REPLACE_ME");
}

function displayText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function webUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", hellip: "…",
};

function decodeHtmlEntitiesOnce(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => HTML_NAMED_ENTITIES[name] ?? match);
}

// Some sources (confirmed live: Greenhouse's job.content) double-encode —
// the field's actual tags arrive as "&lt;p&gt;...&lt;/p&gt;" rather than
// "<p>...</p>", so a single decode pass only reveals literal-looking
// "<p>" text without ever exposing a real tag to strip. Decoding to a
// fixed point (capped at 3 passes — real content never nests this deep,
// this is just a backstop against pathological input) makes htmlToText
// correct regardless of how many layers of encoding a source used.
function decodeHtmlEntities(text: string): string {
  let result = text;
  for (let i = 0; i < 3; i++) {
    const next = decodeHtmlEntitiesOnce(result);
    if (next === result) break;
    result = next;
  }
  return result;
}

// Marks real section headings so the UI can render them distinctly
// instead of flattening "Responsibilities" / "Requirements" / etc. into
// the same run-on body text as everything else. Two patterns cover what
// postings actually use in practice (confirmed live against real Ashby/
// Greenhouse content): real <h1-6> tags, and a <p> or bare <strong>/<b>
// run whose entire short text is the heading (e.g. Greenhouse's
// "<p><strong>ACCOUNTANT, REVENUE</strong></p>") — postings built with a
// plain rich-text editor rarely use real heading tags for this. Emits a
// "### " marker line (own paragraph, blank line on each side) that
// htmlToText's caller can split on; deliberately not real markdown
// syntax elsewhere in this string, so a "### " match is unambiguous.
function markHeadings(html: string): string {
  return html
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n### $1\n")
    .replace(/<p[^>]*>\s*<(?:strong|b)>([^<]{1,80})<\/(?:strong|b)>\s*<\/p>/gi, "\n\n### $1\n")
    .replace(/<(?:strong|b)>([^<]{1,80})<\/(?:strong|b)>\s*(?=<ul|<ol|<br)/gi, "\n\n### $1\n");
}

/**
 * Converts a posting's rich-text HTML body into readable plain text.
 * Every source below that ships jd_text (Ashby/Lever/Greenhouse/Workable)
 * runs through this — including Ashby/Lever's own "descriptionPlain"
 * field, which despite the name still carries raw entities/leftover
 * markup in practice, not just the sources that obviously needed
 * stripping. Preserves paragraph breaks, marks section headings (see
 * markHeadings), and turns <li> into a "• " bulleted line instead of
 * flattening everything into one run-on paragraph, which a naive
 * tag-strip-to-space (the old per-source approach) did — that, plus not
 * handling double-encoded sources (see decodeHtmlEntities), is what was
 * showing up as "raw HTML" in the Full posting panel. Regex-based, not a
 * DOM parser, so it behaves the same in the TUI's Node process and the
 * desktop app's browser webview — this module is shared by both.
 */
function htmlToText(raw: string): string {
  const html = decodeHtmlEntities(raw);
  const withHeadings = markHeadings(html);
  const withBreaks = withHeadings
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(ul|ol)>/gi, "\n");
  const decoded = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ""));
  return decoded
    .split("\n")
    .map((line) => (line.startsWith("### ") ? line.trim() : line.replace(/[ \t]+/g, " ").trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Lever ships an intro paragraph, an explicitly structured list of
// {text: heading, content: <li>...} sections, and a closing paragraph —
// confirmed live (api.lever.co/v0/postings/<slug>) — rather than one
// blob like every other source. Building sections directly from that
// structure is more reliable than heuristically detecting headings in a
// flattened description, so Lever gets its own builder instead of a bare
// htmlToText(job.descriptionPlain) call.
function leverJdText(job: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const intro = htmlToText(String(job.description ?? ""));
  if (intro) parts.push(intro);
  const lists = Array.isArray(job.lists) ? (job.lists as Array<Record<string, unknown>>) : [];
  for (const item of lists) {
    const heading = displayText(item.text);
    const body = htmlToText(String(item.content ?? ""));
    if (heading || body) parts.push([heading ? `### ${heading}` : undefined, body].filter(Boolean).join("\n"));
  }
  const closing = htmlToText(String(job.additional ?? ""));
  if (closing) parts.push(closing);
  return parts.join("\n\n") || undefined;
}

// --- Pay extraction ------------------------------------------------------
//
// Mirrors src/scripts/jobs/_jd_text.py's extract_pay() exactly — same
// regexes, same magnitude heuristic — so both language runtimes agree on
// the same posting's pay line regardless of which fetched it. Only Ashby
// ships structured compensation data (see fetchAshby below, which uses
// that directly and never calls this); every other source only states
// pay as free text somewhere in the description, so this is a
// best-effort text-mining extractor, same honesty posture as the
// "N people applied" social-proof counter — a signal to show, not a
// guaranteed-accurate structured field.
const PAY_NUM = String.raw`\d{1,3}(?:,\d{3})*(?:\.\d+)?K?`;
const PAY_CURRENCY_CODE = "USD|CAD|GBP|EUR|AUD";
// "g" (global) so these can be scanned for every match in a document via
// matchAll, not just the first — real multi-location postings state a
// genuinely different range per location (confirmed live: Okta's
// separate US/Canada pay-range blocks; Brex's inline "...is $185,320 -
// $231,650 and for SLC it is $164,000 - $205,000").
// A per-number interval tag ("/hr", "/yr", etc.) attached directly to
// EITHER side of the range — confirmed live as a real, common shape
// (Twilio: "$30.09/hr - $37.61/hr", the tag repeated on both numbers,
// not stated once after the range the way "$45 - $65 USD hourly" does).
// Captured (not just consumed) so it can decide the interval directly —
// more reliable than the forward/magnitude fallbacks below, and the only
// way to detect it at all here, since once consumed inside the match
// it's no longer sitting in the text *after* the match for
// detectPayInterval to find.
const PAY_INLINE_INTERVAL_TAG = String.raw`(?:/\s*(hr|hour|hourly|yr|year|annum))?`;
const PAY_RANGE_DOLLAR_RE = new RegExp(
  String.raw`\$\s?(${PAY_NUM})${PAY_INLINE_INTERVAL_TAG}\s*(?:-|–|—|to)\s*\$?\s?(${PAY_NUM})${PAY_INLINE_INTERVAL_TAG}`,
  "gi",
);
const PAY_RANGE_CODE_RE = new RegExp(String.raw`(${PAY_NUM})\s*(?:-|–|—|to)\s*(${PAY_NUM})\s*(?:${PAY_CURRENCY_CODE})\b`, "gi");
const HOURLY_WORD_RE = /\b(hourly|hour|hr)\b|\/\s*hr\b|per\s+hour/i;
const YEARLY_WORD_RE = /\b(yearly|annual(?:ly)?|year|yr)\b|\/\s*yr\b|per\s+year/i;
const PAY_CONTEXT_WINDOW = 40;
// Looks BACKWARD from a matched range for the location phrase real
// pay-transparency boilerplate states right before the number — "for
// candidates located in Canada is between:", "and for SLC it is"
// (Okta/Brex), "Based in Colorado... :" (Twilio, confirmed live — hence
// "i" flag here: a bullet-list item capitalizes "Based" at its own
// start, not just mid-sentence "based in"). Allows one optional second
// word ("Washington D.C.", "New York") since a single-word capture missed
// real multi-word place names entirely.
const LOCATION_LABEL_RE =
  /(?:located in|based in|for)\s+([A-Z][A-Za-z.]{1,20}(?:\s[A-Z][A-Za-z.]{1,20})?)(?=\s*[,(:]|\s+(?:is|are|it)\b)/gi;
const LOCATION_LABEL_WINDOW = 250;

function parsePayAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "");
  return cleaned.toUpperCase().endsWith("K") ? parseFloat(cleaned.slice(0, -1)) * 1000 : parseFloat(cleaned);
}

function formatPayAmount(value: number, prefix = "$"): string {
  if (value >= 1000) return `${prefix}${Math.round(value / 1000)}K`;
  return Number.isInteger(value) ? `${prefix}${value}` : `${prefix}${value.toFixed(2)}`;
}

function detectPayInterval(text: string, endPos: number): "hour" | "year" | undefined {
  const window = text.slice(endPos, endPos + PAY_CONTEXT_WINDOW);
  if (HOURLY_WORD_RE.test(window)) return "hour";
  if (YEARLY_WORD_RE.test(window)) return "year";
  return undefined;
}

// Best-effort location tag for one matched range — see
// LOCATION_LABEL_RE's own comment. Only meaningful once a posting has
// already been confirmed to state more than one distinct range; a
// single-range posting never needs a label at all.
function locationLabel(text: string, startPos: number): string | undefined {
  let window = text.slice(Math.max(0, startPos - LOCATION_LABEL_WINDOW), startPos);
  // Scoped to the CURRENT bullet only, if inside one — confirmed live as
  // a real bug otherwise: a later bullet whose own location phrase
  // didn't match fell back to an EARLIER bullet's stale match still
  // sitting in the window (Twilio's 2nd range wrongly labeled
  // "Colorado", the 1st bullet's own location, instead of showing no
  // label at all).
  const lastBullet = window.lastIndexOf("•");
  if (lastBullet !== -1) window = window.slice(lastBullet);
  const matches = [...window.matchAll(LOCATION_LABEL_RE)];
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : undefined;
}

function tagToInterval(tag: string | undefined): "hour" | "year" | undefined {
  if (!tag) return undefined;
  return tag.toLowerCase().startsWith("hr") || tag.toLowerCase().startsWith("hour") ? "hour" : "year";
}

interface PaySpan {
  start: number;
  end: number;
  low: number;
  high: number;
  inlineInterval: "hour" | "year" | undefined;
}

// Every non-overlapping range match in the document, dollar-prefixed or
// currency-code-suffixed, sorted by position — start/end of the OUTER
// match span, used both for interval detection (forward) and location-
// label detection (backward). inlineInterval comes from a "/hr"-style
// tag attached directly to either number when present — only
// PAY_RANGE_DOLLAR_RE has this capability; PAY_RANGE_CODE_RE's groups
// are just (low, high).
function findAllPaySpans(text: string): PaySpan[] {
  const spans: PaySpan[] = [];
  for (const m of text.matchAll(PAY_RANGE_DOLLAR_RE)) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      low: parsePayAmount(m[1]),
      high: parsePayAmount(m[3]),
      inlineInterval: tagToInterval(m[2]) ?? tagToInterval(m[4]),
    });
  }
  for (const m of text.matchAll(PAY_RANGE_CODE_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, low: parsePayAmount(m[1]), high: parsePayAmount(m[2]), inlineInterval: undefined });
  }
  return spans.sort((a, b) => a.start - b.start);
}

// Deliberately RANGE-only — never a single dollar amount. A lone number
// latched onto real but unrelated dollar mentions twice, live, with an
// interval word coincidentally nearby ("revenue targets >$1M per year"
// as a job requirement; "a $1,500 USD learning stipend... per year" as a
// benefit) — a plausibility floor on the number alone wasn't enough,
// since both looked like perfectly reasonable amounts on their own.
// Pay-transparency laws (CA/CO/NY/WA and others) have also made stating
// an actual range the norm for real compensation disclosure, while
// stipends/bonuses/targets are almost always single numbers — so
// restricting to ranges trades a modest amount of recall (postings that
// state one flat number) for meaningfully higher precision (never
// confidently mislabeling a stipend as a salary).
//
// Scans the WHOLE document for every distinct range, not just the
// first — confirmed live that real multi-location postings state a
// genuinely different range per location (Okta: separate US/Canada pay-
// range blocks; Brex: "...is $185,320 - $231,650 and for SLC it is
// $164,000 - $205,000" inline) — returning only the first would silently
// show one location's number as if it applied everywhere. When 2+
// distinct ranges are found, each gets its own best-effort location
// label and they're joined with " · "; a single-range posting gets no
// label at all, nothing to disambiguate from.
function extractPay(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const spans = findAllPaySpans(text);
  if (spans.length === 0) return undefined;
  const seen = new Set<string>();
  const formatted: Array<{ value: string; start: number }> = [];
  for (const { start, end, low, high, inlineInterval } of spans) {
    const key = `${low}|${high}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const interval = inlineInterval ?? detectPayInterval(text, end) ?? (Math.max(low, high) < 1000 ? "hour" : "year");
    const suffix = interval === "hour" ? "hr" : "yr";
    formatted.push({ value: `${formatPayAmount(low)}–${formatPayAmount(high)}/${suffix}`, start });
  }
  if (formatted.length === 1) return formatted[0].value;
  return formatted
    .map(({ value, start }) => {
      const label = locationLabel(text, start);
      return label ? `${value} (${label})` : value;
    })
    .join(" · ");
}

// Ashby is the one source with real structured compensation data
// (confirmed live: job.compensation.summaryComponents[] carries
// minValue/maxValue/currencyCode/interval directly) — using it beats
// text-mining, especially for the hourly-vs-yearly call, which the
// regex path can only guess at via a magnitude heuristic. Falls back to
// text-mining (first the tier summary string, then jd_text itself) for
// the real minority of postings that don't have compensation filled in
// at all — same "best-effort, never invents a number" posture as the
// generic extractPay() path every other source uses exclusively.
function ashbyPayText(job: Record<string, unknown>, jdText: string | undefined): string | undefined {
  const compensation = job.compensation as Record<string, unknown> | undefined;
  const summaryComponents = Array.isArray(compensation?.summaryComponents)
    ? (compensation!.summaryComponents as Array<Record<string, unknown>>)
    : [];
  const salaries = summaryComponents.filter(
    (c) => c.compensationType === "Salary" && typeof c.minValue === "number" && typeof c.maxValue === "number",
  );
  if (salaries.length > 0) {
    // compensationTiers[].title carries a location name for companies
    // that post one tier per location (null for the common single-tier
    // case) — same "no label when there's nothing to disambiguate"
    // posture as the regex path's multi-location handling below.
    const tiers = Array.isArray(compensation?.compensationTiers)
      ? (compensation!.compensationTiers as Array<Record<string, unknown>>)
      : [];
    const formatted = salaries.map((salary, i) => {
      const currencyCode = String(salary.currencyCode ?? "USD");
      const prefix = currencyCode === "USD" ? "$" : `${currencyCode} `;
      const suffix = String(salary.interval ?? "").toUpperCase().includes("HOUR") ? "hr" : "yr";
      const value = `${formatPayAmount(salary.minValue as number, prefix)}–${formatPayAmount(salary.maxValue as number, prefix)}/${suffix}`;
      const label = displayText(tiers[i]?.title) || undefined;
      return label ? `${value} (${label})` : value;
    });
    return formatted.join(" · ");
  }
  return extractPay(displayText(compensation?.compensationTierSummary)) ?? extractPay(jdText);
}

export async function readTargets(root: string): Promise<Targets> {
  return JSON.parse(await fs.readFile(path.join(root, "src", "config", "targets.json"), "utf8")) as Targets;
}

/** One retry on any failure (timeout, network blip, transient 5xx/429) —
 *  hitting 8+ boards concurrently occasionally trips a board's rate
 *  limiter or a slow DNS/TLS handshake, and a single retry after a short
 *  pause clears most of those without masking a genuinely dead/renamed
 *  slug (which fails the retry too, and is what should still surface). */
async function fetchJson(url: string, attempt = 0): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    if (attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return fetchJson(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const d = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const SLUG_NAME_MAX = 14;

function sourceSummary(total: number, failedSlugs: string[], count: number): SourceResult {
  if (total === 0) return { state: "skipped", count: 0, detail: "not configured" };
  if (failedSlugs.length > 0) {
    const short = (s: string) => (s.length > SLUG_NAME_MAX ? `${s.slice(0, SLUG_NAME_MAX)}…` : s);
    const names = failedSlugs.slice(0, 2).map(short).join(", ") + (failedSlugs.length > 2 ? "…" : "");
    return { state: "warning", count, detail: `${failedSlugs.length}/${total} failed: ${names}` };
  }
  return { state: "ready", count };
}

export async function fetchAshby(slugs: string[]): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  const results = await Promise.allSettled(
    slugs.map(async (slug) => {
      const payload = (await fetchJson(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
      )) as { jobs?: Array<Record<string, unknown>> };
      return (payload.jobs ?? []).flatMap((job): SearchJob[] => {
        const title = displayText(job.title);
        const url = webUrl(job.jobUrl ?? job.applyUrl);
        if (!title || !url) return [];
        // descriptionHtml, not descriptionPlain — confirmed live, Ashby's
        // "plain" field has no heading structure at all (already
        // flattened), while descriptionHtml keeps real <h3>/<strong>
        // section headings for markHeadings to pick up.
        const jdText = htmlToText(String(job.descriptionHtml ?? job.descriptionPlain ?? "")) || undefined;
        return [{
          source: "ashbyhq",
          company: slug,
          title,
          url,
          apply_url: webUrl(job.applyUrl) || undefined,
          external_job_id: displayText(job.id) || undefined,
          location: displayText(job.location) || undefined,
          jd_text: jdText,
          pay_text: ashbyPayText(job, jdText),
          posted_at: isoOrUndefined(job.publishedAt),
        }];
      });
    }),
  );
  const jobs = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const failedSlugs = slugs.filter((_, i) => results[i].status === "rejected");
  return { jobs, source: sourceSummary(slugs.length, failedSlugs, jobs.length) };
}

export async function fetchLever(slugs: string[]): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  const results = await Promise.allSettled(
    slugs.map(async (slug) => {
      const payload = (await fetchJson(
        `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
      )) as Array<Record<string, unknown>>;
      return (Array.isArray(payload) ? payload : []).flatMap((job): SearchJob[] => {
        const title = displayText(job.text);
        const url = webUrl(job.hostedUrl ?? job.applyUrl);
        if (!title || !url) return [];
        const categories = (job.categories ?? {}) as Record<string, unknown>;
        const jdText = leverJdText(job);
        return [{
          source: "lever",
          company: slug,
          title,
          url,
          apply_url: webUrl(job.applyUrl) || undefined,
          external_job_id: displayText(job.id) || undefined,
          location: displayText(categories.location) || undefined,
          jd_text: jdText,
          pay_text: extractPay(jdText),
          posted_at: isoOrUndefined(job.createdAt),
        }];
      });
    }),
  );
  const jobs = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const failedSlugs = slugs.filter((_, i) => results[i].status === "rejected");
  return { jobs, source: sourceSummary(slugs.length, failedSlugs, jobs.length) };
}

export async function fetchGreenhouse(slugs: string[]): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  const results = await Promise.allSettled(
    slugs.map(async (slug) => {
      const payload = (await fetchJson(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
      )) as { jobs?: Array<Record<string, unknown>> };
      return (payload.jobs ?? []).flatMap((job): SearchJob[] => {
        const title = displayText(job.title);
        const url = webUrl(job.absolute_url);
        if (!title || !url) return [];
        const location = (job.location ?? {}) as Record<string, unknown>;
        const jdText = htmlToText(String(job.content ?? "")) || undefined;
        return [{
          source: "greenhouse",
          company: slug,
          title,
          url,
          external_job_id: displayText(job.id) || undefined,
          location: displayText(location.name) || undefined,
          jd_text: jdText,
          pay_text: extractPay(jdText),
          posted_at: isoOrUndefined(job.updated_at),
        }];
      });
    }),
  );
  const jobs = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const failedSlugs = slugs.filter((_, i) => results[i].status === "rejected");
  return { jobs, source: sourceSummary(slugs.length, failedSlugs, jobs.length) };
}

const SR_PAGE_SIZE = 100;
// Some SmartRecruiters companies list thousands of postings (mostly
// retail/store roles) — cap pagination per company so one huge board
// can't starve the other configured sources of request budget during a
// manual search. The automated agent's own fetch helper
// (src/scripts/jobs/fetch_smartrecruiters_listings.py) applies its own,
// separate cap for the same reason.
const SR_FETCH_CAP = 500;

async function fetchSmartRecruitersCompany(slug: string, query: string): Promise<SearchJob[]> {
  const jobs: SearchJob[] = [];
  let offset = 0;
  // The API supports server-side keyword filtering (`q=`) — confirmed
  // live: Dominos alone lists 24k+ postings, and fetching that unfiltered
  // meant paginating to the SR_FETCH_CAP every single search (~3s of
  // sequential requests, the dominant cost in a slow search). Passing the
  // query here typically drops a large board to a single page.
  const q = query ? `&q=${encodeURIComponent(query)}` : "";
  for (;;) {
    const payload = (await fetchJson(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?offset=${offset}&limit=${SR_PAGE_SIZE}${q}`,
    )) as { content?: Array<Record<string, unknown>>; totalFound?: number };
    const postings = payload.content ?? [];
    for (const posting of postings) {
      const title = displayText(posting.name);
      const id = displayText(posting.id);
      if (!title || !id) continue;
      const location = (posting.location ?? {}) as Record<string, unknown>;
      jobs.push({
        source: "smartrecruiters",
        company: slug,
        title,
        // Confirmed live: the ID-only URL resolves directly (no redirect
        // needed), so a per-posting detail fetch isn't needed just to
        // produce a working listing URL — only for jd_text (fetched
        // lazily at fit-check time, see checkJobFit below).
        url: `https://jobs.smartrecruiters.com/${slug}/${id}`,
        external_job_id: id,
        location: displayText(location.fullLocation) || undefined,
        posted_at: isoOrUndefined(posting.releasedDate),
      });
    }
    offset += SR_PAGE_SIZE;
    if (postings.length === 0 || offset >= (payload.totalFound ?? 0) || offset >= SR_FETCH_CAP) break;
  }
  return jobs;
}

export async function fetchSmartRecruiters(slugs: string[], query: string): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  const results = await Promise.allSettled(slugs.map((slug) => fetchSmartRecruitersCompany(slug, query)));
  const jobs = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const failedSlugs = slugs.filter((_, i) => results[i].status === "rejected");
  return { jobs, source: sourceSummary(slugs.length, failedSlugs, jobs.length) };
}

async function fetchWorkableCompany(slug: string): Promise<SearchJob[]> {
  // No pagination, no server-side query param on this endpoint (confirmed
  // live 2026-08-10) — one GET returns a company's whole open-postings
  // list, jd_text included, so title filtering happens client-side same
  // as Amazon/Muse's own title match downstream in searchJobs().
  const payload = (await fetchJson(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
  )) as { name?: string; jobs?: Array<Record<string, unknown>> };
  const company = displayText(payload.name) || slug;
  return (payload.jobs ?? []).flatMap((job): SearchJob[] => {
    const title = displayText(job.title);
    const url = webUrl(job.url ?? job.shortlink);
    const externalId = displayText(job.shortcode);
    if (!title || !url || !externalId) return [];
    const locations = (job.locations as Array<Record<string, unknown>> | undefined) ?? [];
    const loc = locations[0] ?? {};
    const locationParts = [loc.city, loc.region, loc.country].map((v) => displayText(v)).filter(Boolean);
    // Full JD text ships in the list response (confirmed live) — no
    // separate detail fetch needed, same as Amazon/Muse.
    const jdText = htmlToText(String(job.description ?? "")) || undefined;
    return [{
      source: "workable",
      company,
      title,
      url,
      apply_url: webUrl(job.application_url) || undefined,
      external_job_id: externalId,
      location: locationParts.join(", ") || undefined,
      jd_text: jdText,
      pay_text: extractPay(jdText),
      posted_at: isoOrUndefined(job.published_on),
    }];
  });
}

export async function fetchWorkable(slugs: string[]): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  const results = await Promise.allSettled(slugs.map((slug) => fetchWorkableCompany(slug)));
  const jobs = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const failedSlugs = slugs.filter((_, i) => results[i].status === "rejected");
  return { jobs, source: sourceSummary(slugs.length, failedSlugs, jobs.length) };
}

async function runJson(root: string, command: string, args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

/** runJson under the resolved Python interpreter (cross-platform). */
function runPyJson(root: string, args: string[]): Promise<unknown> {
  const p = py(args);
  return runJson(root, p.cmd, p.args);
}

/** Same as runPyJson, but for a JSONL (one object per line) response —
 *  the shape canonicalize-batch/evaluate_job_fit.py --batch use so a
 *  page of jobs costs 2 subprocess spawns total, not 2 per job. */
async function runPyLines(root: string, args: string[]): Promise<unknown[]> {
  const p = py(args);
  const { stdout } = await execFileAsync(p.cmd, p.args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function fetchWorkday(root: string, query: string, pageSize: number): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  try {
    const wd = py(["src/scripts/jobs/fetch_workday_listings.py", "--search", query, "--limit", String(pageSize), "--timeout", "8"]);
    const { stdout, stderr } = await execFileAsync(
      wd.cmd,
      wd.args,
      { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
    );
    const jobs = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SearchJob)
      .map((job) => ({
        ...job,
        company: displayText(job.company),
        title: displayText(job.title),
        url: webUrl(job.url),
        location: displayText(job.location) || undefined,
      }))
      .filter((job) => job.company && job.title && job.url);
    const skipped = /tenants=0/.test(stderr);
    return {
      jobs,
      source: skipped
        ? { state: "skipped", count: 0, detail: "not configured" }
        : { state: "ready", count: jobs.length },
    };
  } catch (err) {
    return { jobs: [], source: { state: "warning", count: 0, detail: errorMessage(err) } };
  }
}

/** Amazon is a single company, not a multi-tenant ATS — no per-company
 *  config to check for "not configured"; a failed fetch is always a
 *  warning, never a clean skip. */
async function fetchAmazon(root: string, query: string, pageSize: number): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  try {
    const az = py(["src/scripts/jobs/fetch_amazon_listings.py", "--search", query, "--limit", String(pageSize), "--timeout", "8"]);
    const { stdout, stderr } = await execFileAsync(
      az.cmd,
      az.args,
      { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
    );
    const jobs = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SearchJob)
      .map((job) => ({
        ...job,
        company: displayText(job.company),
        title: displayText(job.title),
        url: webUrl(job.url),
        location: displayText(job.location) || undefined,
      }))
      .filter((job) => job.company && job.title && job.url);
    const failed = /failed=true/.test(stderr);
    return {
      jobs,
      source: failed && jobs.length === 0
        ? { state: "warning", count: 0, detail: errorMessage(new Error(stderr.trim() || "fetch failed")) }
        : { state: "ready", count: jobs.length },
    };
  } catch (err) {
    return { jobs: [], source: { state: "warning", count: 0, detail: errorMessage(err) } };
  }
}

async function fetchOracle(root: string, query: string, pageSize: number): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  try {
    const orc = py(["src/scripts/jobs/fetch_oracle_listings.py", "--search", query, "--limit", String(pageSize), "--timeout", "8"]);
    const { stdout, stderr } = await execFileAsync(
      orc.cmd,
      orc.args,
      { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
    );
    const jobs = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SearchJob)
      .map((job) => ({
        ...job,
        company: displayText(job.company),
        title: displayText(job.title),
        url: webUrl(job.url),
        location: displayText(job.location) || undefined,
      }))
      .filter((job) => job.company && job.title && job.url);
    const skipped = /tenants=0/.test(stderr);
    return {
      jobs,
      source: skipped
        ? { state: "skipped", count: 0, detail: "not configured" }
        : { state: "ready", count: jobs.length },
    };
  } catch (err) {
    return { jobs: [], source: { state: "warning", count: 0, detail: errorMessage(err) } };
  }
}

/** The Muse is an aggregator across many employers/ATSes, not a single
 *  company — but like Amazon it has no per-company config to check for
 *  "not configured", so a failed fetch is always a warning, never a
 *  clean skip. */
async function fetchMuse(root: string, query: string, pageSize: number): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  try {
    const muse = py(["src/scripts/jobs/fetch_muse_listings.py", "--search", query, "--limit", String(pageSize), "--timeout", "8"]);
    const { stdout, stderr } = await execFileAsync(
      muse.cmd,
      muse.args,
      { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
    );
    const jobs = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SearchJob)
      .map((job) => ({
        ...job,
        company: displayText(job.company),
        title: displayText(job.title),
        url: webUrl(job.url),
        location: displayText(job.location) || undefined,
      }))
      .filter((job) => job.company && job.title && job.url);
    const failed = /failed=true/.test(stderr);
    return {
      jobs,
      source: failed && jobs.length === 0
        ? { state: "warning", count: 0, detail: errorMessage(new Error(stderr.trim() || "fetch failed")) }
        : { state: "ready", count: jobs.length },
    };
  } catch (err) {
    return { jobs: [], source: { state: "warning", count: 0, detail: errorMessage(err) } };
  }
}

/** Community listing-tracker aggregators (SimplifyJobs + vanshb03's sibling
 *  trackers — see fetch_simplify_listings.py). Previously only wired into
 *  the autonomous agent pipeline (job-scraper.md Phase 1) and a one-off
 *  onboarding company-picker script, never this interactive search path —
 *  meaning the single highest-volume, zero-maintenance source (SimplifyJobs
 *  + vanshb03 combined) was invisible in the Jobs screen despite already
 *  being fully configured (targets.json's simplify_feeds). Unlike the
 *  per-company board fetchers, one process call here returns raw JSONL
 *  across every configured feed — there's no `--search` flag on the
 *  script; the merged result set is title-filtered downstream the same
 *  as every other source (searchJobs()'s own `matched` filter). Carries
 *  no jd_text (the feed doesn't include JD bodies) — Apply with aplyx
 *  doesn't need it (the real agent pipeline fetches the JD itself per
 *  AGENTS.md's board-specific fetch method for this source), but the
 *  per-job "Check fit" button will show a no-match score here until a
 *  generic per-URL JD fetch exists for this source specifically. */
async function fetchSimplify(root: string, pageSize: number): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  try {
    const sim = py(["src/scripts/jobs/fetch_simplify_listings.py", "--limit", String(pageSize)]);
    const { stdout, stderr } = await execFileAsync(
      sim.cmd,
      sim.args,
      { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 60_000 },
    );
    const jobs = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SearchJob)
      .map((job) => ({
        ...job,
        company: displayText(job.company),
        title: displayText(job.title),
        url: webUrl(job.url),
        location: displayText(job.location) || undefined,
      }))
      .filter((job) => job.company && job.title && job.url);
    // "feeds=0 jobs=0 failed=0" — simplify_feeds unset/empty/placeholder,
    // a clean configured skip (see load_configured_feeds's own doc
    // comment). Distinct from "feeds=0 jobs=0 failed=<n>" (every
    // configured feed genuinely failed to fetch), which should surface
    // as a warning, not a silent "not configured".
    const cleanSkip = /feeds=0 jobs=0 failed=0/.test(stderr);
    return {
      jobs,
      source: cleanSkip
        ? { state: "skipped", count: 0, detail: "not configured" }
        : { state: "ready", count: jobs.length },
    };
  } catch (err) {
    return { jobs: [], source: { state: "warning", count: 0, detail: errorMessage(err) } };
  }
}

const DISABLED_SOURCE: SourceResult = { state: "skipped", count: 0, detail: "disabled" };

/** Checks the shared job_cache table before falling back to a live
 *  per-source fetch (see jobCache.ts). Cache rows are always populated
 *  under query='' (refreshJobCache.ts stores the full unfiltered board,
 *  same shape Ashby/Lever/Greenhouse/SmartRecruiters already fetch live)
 *  — the final, authoritative query-string matching still happens
 *  downstream on the merged result set via titleMatchesQuery, exactly
 *  the same for a cached or a live job. The search query is also passed
 *  through to readJobCache as a loose pre-filter (migration 0005) so
 *  the per-company cap inside the RPC applies to relevant candidates,
 *  not an arbitrary sample — confirmed live, without this a query like
 *  "intern" could return zero cache results for a company that has
 *  real intern postings cached, just because none landed in an
 *  unfiltered top-N sample. Only wired for the four sources
 *  refreshJobCache.ts actually populates;
 *  Amazon/Oracle/Workday (Python-backed, no refresh job yet — see that
 *  file's header) skip the cache check entirely rather than pay a lookup
 *  that can never hit.
 *
 *  The actual search scope for a source is the UNION of companySlugs
 *  (the user's own src/config/targets.json list) and the shared cache's
 *  whole company list (src/config/job_cache_targets.json, ~47 companies,
 *  the same for every install) — not either list alone. This is a
 *  second, distinct fix from an earlier one: first, making sure a
 *  user's own companies never get silently dropped when they're absent
 *  from the shared cache; second (this one, found after the first was
 *  already live), making sure the shared cache's OTHER companies
 *  actually get searched at all. Before this, searchJobs() only ever
 *  iterated a source's *personal* slug list — the shared cache could
 *  only ever speed up and correctly cover a user's own existing list,
 *  never actually expand what got searched, which defeats the entire
 *  point of job_cache_targets.json being a curated, broader company
 *  list in the first place. Confirmed live: SpaceX (only in the shared
 *  list, not in any personal one tested) never appeared in results for
 *  any query, no matter how broad, cache or no cache.
 *
 *  The shared list is always queried via cache; whichever of the
 *  user's own companies aren't already part of it are the live-only
 *  subset, always live-fetched regardless of the cache outcome. If the
 *  cache read itself fails/misses entirely, this falls back to live-
 *  fetching just companySlugs (the user's own list) rather than the
 *  full shared set — live-fetching ~47 companies as a degraded-mode
 *  fallback would be slow/heavy and defeats the point of the cache
 *  being what makes that set fast in the first place.
 *
 *  withDeadline is applied here, around each live() call only — NOT
 *  around the whole function via the call site (as it briefly was) —
 *  deliberately. Wrapping the whole thing in one shared
 *  SOURCE_DEADLINE_MS meant a slow cache lookup (readJobCache's own
 *  internal timeout is up to CACHE_LOOKUP_TIMEOUT_MS, currently 1200ms)
 *  could eat most of that budget before falling through, leaving the
 *  live fallback well under a second to complete a real API call it
 *  normally gets ~2.2s for. Confirmed live: this silently starved
 *  Ashby/Lever/Greenhouse/SmartRecruiters down to near-zero results on
 *  a slow cache round trip while Amazon/Oracle/Workday (never wired
 *  into caching, so unaffected) kept working normally — search looked
 *  like "only Amazon shows up." Giving each live() call its own fresh
 *  deadline means a cache check can never cost the live fallback any of
 *  its normal time budget, at the cost of a higher combined worst case
 *  (cache timeout + full live timeout, additive, if both are slow) —
 *  correctness over the tighter bound. */
async function maybeCached(
  root: string,
  source: JobSource,
  companySlugs: string[],
  label: string,
  query: string,
  live: (slugs: string[]) => Promise<{ jobs: SearchJob[]; source: SourceResult }>,
): Promise<{ jobs: SearchJob[]; source: SourceResult }> {
  const shared = await sharedCacheSlugs(root, source);
  const cacheTargets = [...shared];
  const liveOnly = companySlugs.filter((slug) => !shared.has(slug));

  const titleWords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cached = cacheTargets.length > 0
    ? await readJobCache(root, { source, companySlugs: cacheTargets, query: "", titleWords })
    : undefined;

  // If the cache-eligible portion missed, it needs a live fetch of
  // itself too — not just the always-live-only companies.
  const needsLive = cached ? liveOnly : companySlugs;
  const liveResult = needsLive.length > 0
    ? await withDeadline(live(needsLive), label)
    : { jobs: [], source: { state: "skipped", count: 0, detail: "not configured" } as SourceResult };

  const jobs = [...(cached ?? []), ...liveResult.jobs];
  if (jobs.length > 0) return { jobs, source: { state: "ready", count: jobs.length } };
  return { jobs, source: liveResult.source };
}

export async function searchJobs(
  root: string,
  query: string,
  enabled: Partial<Record<JobSource, boolean>> = {},
): Promise<SearchResult> {
  const targets = await readTargets(root);
  const pageSize = resolvePageSize(root);
  const isOn = (source: JobSource) => enabled[source] !== false;
  const ashbySlugs = isOn("ashbyhq") ? configured(targets.ashby_company_slugs) : [];
  const leverSlugs = isOn("lever") ? configured(targets.lever_company_slugs) : [];
  const greenhouseSlugs = isOn("greenhouse") ? configured(targets.greenhouse_company_slugs) : [];
  const smartrecruitersSlugs = isOn("smartrecruiters") ? configured(targets.smartrecruiters_company_slugs) : [];
  const workableSlugs = isOn("workable") ? configured(targets.workable_company_slugs) : [];
  const [ashby, lever, greenhouse, smartrecruiters, workable, amazon, oracle, workday, muse, simplify] = await Promise.all([
    maybeCached(root, "ashbyhq", ashbySlugs, "Ashby", query, (slugs) => fetchAshby(slugs)),
    maybeCached(root, "lever", leverSlugs, "Lever", query, (slugs) => fetchLever(slugs)),
    maybeCached(root, "greenhouse", greenhouseSlugs, "Greenhouse", query, (slugs) => fetchGreenhouse(slugs)),
    maybeCached(root, "smartrecruiters", smartrecruitersSlugs, "SmartRecruiters", query, (slugs) => fetchSmartRecruiters(slugs, query)),
    // Not wired into the shared job_cache system (unlike the four above)
    // — Workable was only just added (2026-08-10) and job_cache_targets.json/
    // refreshJobCache.ts don't populate it yet. Plain withDeadline, same
    // short fetch()-based-source budget as the cached sources get for
    // their own live fallback (SOURCE_DEADLINE_MS, the default — this is
    // one GET per company, no pagination, not a Python subprocess).
    withDeadline(fetchWorkable(workableSlugs), "Workable"),
    isOn("amazon") ? withDeadline(fetchAmazon(root, query, LIVE_SOURCE_FETCH_LIMIT), "Amazon", PYTHON_SOURCE_DEADLINE_MS) : Promise.resolve({ jobs: [], source: DISABLED_SOURCE }),
    isOn("oracle") ? withDeadline(fetchOracle(root, query, LIVE_SOURCE_FETCH_LIMIT), "Oracle", PYTHON_SOURCE_DEADLINE_MS) : Promise.resolve({ jobs: [], source: DISABLED_SOURCE }),
    isOn("workday") ? withDeadline(fetchWorkday(root, query, LIVE_SOURCE_FETCH_LIMIT), "Workday", PYTHON_SOURCE_DEADLINE_MS) : Promise.resolve({ jobs: [], source: DISABLED_SOURCE }),
    isOn("muse") ? withDeadline(fetchMuse(root, query, LIVE_SOURCE_FETCH_LIMIT), "The Muse", PYTHON_SOURCE_DEADLINE_MS) : Promise.resolve({ jobs: [], source: DISABLED_SOURCE }),
    // One toggle ("simplify") gates the whole call even though results
    // carry per-job source "simplify" or "vanshb03" — see fetchSimplify's
    // own doc comment for why this used to be invisible here entirely.
    isOn("simplify") ? withDeadline(fetchSimplify(root, LIVE_SOURCE_FETCH_LIMIT), "Simplify", PYTHON_SOURCE_DEADLINE_MS) : Promise.resolve({ jobs: [], source: DISABLED_SOURCE }),
  ]);
  // Keyed on a normalized (company, title, location) triple, not job.url —
  // aggregators (The Muse and Simplify/vanshb03 here) link their own
  // landing/tracking page rather than the employer's real ATS URL, so the
  // same real posting reached through two different sources used to show
  // up twice. See dedupeKey's own doc comment for exactly what
  // "normalized" means and why it's exact-match, not fuzzy.
  const seen = new Set<string>();
  const deduped = [...ashby.jobs, ...lever.jobs, ...greenhouse.jobs, ...smartrecruiters.jobs, ...workable.jobs, ...amazon.jobs, ...oracle.jobs, ...workday.jobs, ...muse.jobs, ...simplify.jobs].filter((job) => {
    const key = dedupeKey(job);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Cut stale postings — old listings that are probably already filled or
  // pulled crowd out genuinely fresh ones, and a bounded window is also
  // what makes the table's year-less short date display unambiguous (see
  // SearchScreen's formatPosted). Unknown-age jobs (no posted_at) are kept
  // rather than dropped — missing data isn't evidence of staleness.
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const recent = deduped.filter((job) => {
    if (!job.posted_at) return true;
    const t = new Date(job.posted_at).getTime();
    return Number.isNaN(t) || t >= sixMonthsAgo.getTime();
  });
  // Title-only match, every query word required, inflection-tolerant per
  // word — see titleMatchesQuery for why exact substring matching was
  // hiding real postings.
  const matched = recent.filter((job) => titleMatchesQuery(job.title, query));
  // Preferred locations sort to the first page; everything else follows.
  const preferred = readTargetsArrayList(root, "preferred_locations");
  const jobs = sortByPreferredThenPosted(matched, preferred).slice(0, pageSize);

  // Counts reflect postings that actually matched the query, not the raw
  // firehose fetched from each board — a lone "2260" next to Ashby told
  // the user nothing about their search and mostly just cluttered the row.
  const matchedCountBySource: Partial<Record<JobSource, number>> = {};
  for (const job of matched) {
    matchedCountBySource[job.source] = (matchedCountBySource[job.source] ?? 0) + 1;
  }
  const withMatchedCount = (source: SourceResult, key: JobSource): SourceResult =>
    source.state === "skipped" ? source : { ...source, count: matchedCountBySource[key] ?? 0 };

  return {
    jobs,
    sources: {
      ashbyhq: withMatchedCount(ashby.source, "ashbyhq"),
      lever: withMatchedCount(lever.source, "lever"),
      greenhouse: withMatchedCount(greenhouse.source, "greenhouse"),
      smartrecruiters: withMatchedCount(smartrecruiters.source, "smartrecruiters"),
      workable: withMatchedCount(workable.source, "workable"),
      amazon: withMatchedCount(amazon.source, "amazon"),
      oracle: withMatchedCount(oracle.source, "oracle"),
      workday: withMatchedCount(workday.source, "workday"),
      muse: withMatchedCount(muse.source, "muse"),
      // One fetch call, two per-job source values (see fetchSimplify) —
      // both share simplify.source's state/detail, matched-count only
      // splits by which tracker each job actually came from.
      simplify: withMatchedCount(simplify.source, "simplify"),
      vanshb03: withMatchedCount(simplify.source, "vanshb03"),
    },
  };
}

async function canonicalize(root: string, job: SearchJob): Promise<CanonicalJob> {
  return await runPyJson(root, [
    "src/scripts/state/job_state.py",
    "canonicalize",
    JSON.stringify(job),
  ]) as CanonicalJob;
}

export async function checkJobFit(root: string, job: SearchJob): Promise<FitResult> {
  let raw = job;
  if (job.source === "workday") {
    raw = await runPyJson(root, [
      "src/scripts/jobs/fetch_workday_listings.py",
      "--jd-url",
      job.url,
    ]) as SearchJob;
  } else if (job.source === "smartrecruiters") {
    raw = await runPyJson(root, [
      "src/scripts/jobs/fetch_smartrecruiters_listings.py",
      "--jd-url",
      job.url,
    ]) as SearchJob;
  } else if (job.source === "oracle") {
    raw = await runPyJson(root, [
      "src/scripts/jobs/fetch_oracle_listings.py",
      "--jd-url",
      job.url,
    ]) as SearchJob;
  }
  // Amazon needs no branch here — the list response already carries full
  // jd_text (confirmed live), unlike Workday/SmartRecruiters/Oracle.
  const canonical = await canonicalize(root, raw);
  const result = await runPyJson(root, [
    "src/scripts/jobs/evaluate_job_fit.py",
    JSON.stringify(canonical),
  ]) as FitResult;
  if (!["candidate", "needs_review", "skipped_unfit"].includes(result.fit_status)) {
    throw new Error("fit helper returned an unexpected status");
  }
  return result;
}

/** Fit-checks many jobs in 2 subprocess spawns total (canonicalize-batch,
 *  then evaluate_job_fit.py --batch) instead of 2 per job — for browsing a
 *  whole page of search results at once rather than one manual "Check
 *  fit" click at a time. Deliberately does NOT do the checkJobFit's
 *  per-job JD-backfill fetch (jobHasJdBackfill) — that's a live network
 *  call per posting, which is fine for one manual click but not for
 *  auto-running across a whole page. Callers should filter out
 *  jobHasJdBackfill sources before calling this and leave those to the
 *  existing manual per-job "Check fit" action. Returns a Map keyed by
 *  job.url; a job that failed to canonicalize or fit-check is simply
 *  absent from the map, not an error for the whole batch. */
export async function checkJobFitBatch(root: string, jobs: SearchJob[]): Promise<Record<string, FitResult>> {
  // A plain object, not a Map — this return value crosses the Tauri IPC
  // boundary (JSON), which can't carry a Map.
  const results: Record<string, FitResult> = {};
  if (jobs.length === 0) return results;
  const canonicalJobs = (await runPyLines(root, [
    "src/scripts/state/job_state.py",
    "canonicalize-batch",
    JSON.stringify(jobs),
  ])) as CanonicalJob[];
  if (canonicalJobs.length === 0) return results;
  const fitLines = (await runPyLines(root, [
    "src/scripts/jobs/evaluate_job_fit.py",
    JSON.stringify(canonicalJobs),
    "--batch",
  ])) as Array<FitResult & { ok?: boolean }>;
  canonicalJobs.forEach((canonical, i) => {
    const parsed = fitLines[i];
    if (!parsed || parsed.ok === false) return;
    results[canonical.url] = parsed;
  });
  return results;
}

// Sources whose list-mode fetch deliberately omits jd_text — the full
// description exists, it just lives behind a second per-requisition API
// call (see fetch_oracle_listings.py/fetch_workday_listings.py/
// fetch_smartrecruiters_listings.py's own --jd-url mode) that a bulk
// board listing can't afford to make once per posting. Same source list
// checkJobFit already re-fetches through for exactly this reason.
const JD_BACKFILL_SOURCES: ReadonlySet<JobSource> = new Set(["workday", "smartrecruiters", "oracle"]);

export function jobHasJdBackfill(source: JobSource): boolean {
  return JD_BACKFILL_SOURCES.has(source);
}

/** Lazily fetches the real jd_text/pay_text for a posting whose list-mode
 *  fetch didn't carry one (see JD_BACKFILL_SOURCES) — used by the Jobs
 *  screen's detail view so opening a posting shows its actual description
 *  instead of a permanent "not available," matching what checkJobFit
 *  already does before evaluating fit. Sources outside that set (Simplify
 *  chief among them) have no per-URL JD fetch method at all — this
 *  throws for those rather than silently returning nothing, so the
 *  caller can tell "genuinely unavailable" apart from "fetch failed." */
export async function fetchJobDescription(root: string, job: SearchJob): Promise<{ jd_text?: string; pay_text?: string }> {
  if (!JD_BACKFILL_SOURCES.has(job.source)) {
    throw new Error(`no per-posting JD fetch exists for source '${job.source}'`);
  }
  const script =
    job.source === "workday"
      ? "src/scripts/jobs/fetch_workday_listings.py"
      : job.source === "smartrecruiters"
        ? "src/scripts/jobs/fetch_smartrecruiters_listings.py"
        : "src/scripts/jobs/fetch_oracle_listings.py";
  const raw = (await runPyJson(root, [script, "--jd-url", job.url])) as SearchJob;
  return { jd_text: raw.jd_text, pay_text: raw.pay_text };
}

const RECOMMENDED_JOBS_LIMIT = 12;

async function readRegistry(root: string): Promise<RegistryFitCandidate[]> {
  try {
    const raw = await fs.readFile(path.join(root, "data", "job_registry.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RegistryFitCandidate[]) : [];
  } catch {
    return [];
  }
}

/** Not-yet-applied, fit-passing jobs for the Home screen's recommended-jobs
 *  marquee. Reads the registry directly rather than a live board search —
 *  every entry there was already scraped and canonicalized, so no network
 *  round trip is needed, just the deterministic fit gate. Runs that gate in
 *  one batched process (evaluate_job_fit.py --batch, JSONL output) instead
 *  of one process per candidate — the same need src/worker/'s hosted
 *  pipeline already had at real scale (see evaluate_job_fit.py's --batch
 *  help text), just triggered here by a dashboard read instead of a queue
 *  worker. excludeJobIds is the caller's own state.applied/state.queue
 *  job_ids — this function doesn't re-read those files itself, so there's
 *  one source of truth for "already spoken for" rather than two. */
export async function getRecommendedJobs(root: string, excludeJobIds: string[]): Promise<RecommendedJob[]> {
  const registry = await readRegistry(root);
  const exclude = new Set(excludeJobIds);
  // job_state.py's mark_seen_batch already infers closure (3 consecutive
  // scrapes where a source's fresh listing no longer includes the job —
  // see CLOSED_MISS_THRESHOLD) and persists it onto the registry record.
  // Recommending a job the scraper itself has already flagged as gone
  // would be a straightforwardly wrong recommendation, not a fit-quality
  // question, so this filters before the fit gate ever runs, not after.
  const candidates = registry.filter((job) => job.job_id && !job.closed && !exclude.has(job.job_id));
  if (candidates.length === 0) return [];

  const p = py(["src/scripts/jobs/evaluate_job_fit.py", "--batch", "-"]);
  const { stdout } = await execFileWithStdin(p.cmd, p.args, JSON.stringify(candidates), {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
  });
  // --batch emits JSONL (one result per line, input order preserved, one
  // line even for a malformed item) — not a single JSON value, so this
  // can't go through the runPyJson/runJson single-parse helper; mirrors
  // the same split("\n")/per-line JSON.parse already used for
  // fetchWorkday/fetchAmazon's JSONL output above.
  const results = stdout.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as FitResult);

  const recommended: RecommendedJob[] = [];
  for (let i = 0; i < candidates.length && i < results.length; i++) {
    const fit = results[i];
    if (!fit || fit.fit_status !== "candidate") continue;
    const job = candidates[i];
    recommended.push({
      job_id: job.job_id,
      company: job.company,
      title: job.title,
      url: job.url,
      apply_url: job.normalized_apply_url || job.apply_url || job.url,
      source: job.source,
      role_type: job.role_type,
      location_tier: job.location_tier,
      fit_score: fit.fit_score,
      matched_skills: fit.matched_skills ?? [],
    });
  }
  recommended.sort((a, b) => b.fit_score - a.fit_score);
  return recommended.slice(0, RECOMMENDED_JOBS_LIMIT);
}

function roleType(title: string): "internship" | "new_grad" {
  const value = title.toLowerCase();
  const newGradTerms = [
    "new grad", "new graduate", "entry level", "entry-level", "associate",
    "junior", "early career", "university grad", "campus",
  ];
  return newGradTerms.some((term) => value.includes(term)) ? "new_grad" : "internship";
}

function exitCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "number" ? code : Number(code);
  }
  return undefined;
}

async function appendEntry(root: string, file: string, entry: Record<string, unknown>): Promise<"saved" | "duplicate"> {
  try {
    const ap = py(["src/scripts/state/append_state_entry.py", file, JSON.stringify(entry)]);
    await execFileAsync(ap.cmd, ap.args, {
      cwd: root,
      encoding: "utf8",
    });
    return "saved";
  } catch (err) {
    if (exitCode(err) === 2) return "duplicate";
    throw err;
  }
}

export async function saveJobForReview(root: string, job: SearchJob): Promise<"saved" | "already_saved"> {
  const canonical = await canonicalize(root, job);
  await runPyJson(root, ["src/scripts/state/job_state.py", "upsert-job", JSON.stringify(canonical)]);
  const targets = await readTargets(root);
  const location = (canonical.location ?? "").toLowerCase();
  const preferred = (targets.preferred_locations ?? []).some((candidate) => {
    const value = candidate.toLowerCase();
    return Boolean(value && location.includes(value));
  });
  const entry = {
    job_id: canonical.job_id,
    company: canonical.company,
    title: canonical.title,
    url: canonical.apply_url || canonical.url,
    date_applied: new Date().toISOString().slice(0, 10),
    status: "needs_review",
    role_type: roleType(canonical.title),
    source: canonical.source,
    resume_used: "balanced",
    ats_score: 0,
    location_tier: preferred ? "preferred" : "fallback",
    cover_letter_used: false,
    reasoning: "Saved manually from TUI job search",
  };
  if (await appendEntry(root, "data/applied_jobs.json", entry) === "duplicate") {
    return "already_saved";
  }
  await appendEntry(root, "data/review_queue.json", entry);
  await runPyJson(root, [
    "src/scripts/state/job_state.py",
    "record-event",
    JSON.stringify({
      job_key: canonical.job_key,
      status: "needs_review",
      company: canonical.company,
      title: canonical.title,
      url: entry.url,
      reasoning: entry.reasoning,
    }),
  ]);
  return "saved";
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.split("\n").slice(-2).join(" ");
  }
  return err instanceof Error ? err.message : String(err);
}
