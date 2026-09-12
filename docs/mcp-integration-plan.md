# MCP servers in aplyx: consuming freehire, and whether aplyx should expose its own

> **Status: design/decision doc, nothing built.** No `.mcp.json` entry, no
> new agent-visible tool, and no aplyx-hosted MCP server exist yet. Per
> `AGENTS.md`'s standing rule ("do not introduce a new model name, MCP
> server, or permission surface without explicit operator approval"),
> nothing here proceeds to code until the operator picks an option in each
> open-question section below.

## Why this doc exists

Two separate questions came up together and are easy to conflate, so this
doc keeps them apart:

1. **Consuming an external MCP server** (freehire's) as a new *source* for
   `job-scraper`, to reach boards aplyx can't fetch today.
2. **aplyx exposing its own MCP server**, so other MCP clients (Claude
   Desktop, Claude Code, Cursor, etc.) can read aplyx's own pipeline state
   without opening the app.

These are independent decisions. aplyx could do either, both, or neither.

## Part 1: freehire as a source

### What freehire is

MIT-licensed, self-hostable, written in Go with a SvelteKit frontend
(github.com/strelov1/freehire). It aggregates job postings directly from
company career pages and ATS platforms rather than through recruiter
intermediaries — 3.3M open postings from 294,000+ companies, from 225 live
sources:

- **92 ATS platforms**, explicitly including Workday, Greenhouse, Lever,
  Ashby, and **iCIMS** — the one ATS `docs/icims-automation-research.md`
  already concluded aplyx can't scrape directly (Developer Terms of Use
  prohibit it without a partner/customer relationship).
- **100 aggregators and job boards** (Adzuna, Telegram channels, etc.).
- **30 direct company career-site feeds.**

It exposes the same data through four different surfaces:

- A **free, keyless public HTTP API** at `https://freehire.me/api/v1/jobs`.
- A **standalone CLI**.
- **An MCP server**, built for Claude Desktop/Code.
- A browser extension and a Telegram digest (not relevant to aplyx).

### The API surface (from `freehire.me/docs/api`)

| Endpoint | Purpose |
|---|---|
| `GET /jobs` | List jobs, paginated |
| `GET /jobs/search` | Full-text + faceted search |
| `GET /agent/jobs/search` | Search with full descriptions — the programmatic/agent-consumer variant |
| `GET /jobs/facets` | Count matching jobs per filter value |
| `GET /jobs/{slug}` | Single job detail |
| `GET /jobs/{slug}/similar` | Semantic similarity matching |
| `GET /jobs/{slug}/copies` | Per-city duplicate postings |

Auth: session cookie (browser) or bearer personal API key (non-browser);
neither is required for the plain jobs-search surface. Errors are
`{ "error": "message" }` with standard HTTP codes (400/401/403/404/503).
Search pagination is capped at `offset + limit ≤ 10,000`. No pricing is
disclosed — the hosted API reads as free at the tier aplyx would use.

### How it would fit into aplyx today

`job-scraper.md` currently hand-writes one fetcher per ATS: direct
`GET` calls to Ashby/Lever/Greenhouse's own posting APIs, a dedicated
Python helper for Workday (`fetch_workday_listings.py`), and so on — each
board aplyx adds is its own bespoke integration, and boards with no public
API (iCIMS) or an aggregator-shaped surface (Adzuna) are simply out of
reach. Adding freehire's MCP server to `.mcp.json` would give the
orchestrator one more callable tool: `job-scraper` could search across all
225 sources through a single interface, instead of a fetcher per source.
This is additive — it wouldn't replace the existing Ashby/Lever/Greenhouse
direct-API fetchers, which are cheap, fast, and already working; it would
specifically close the gap on boards aplyx has no path to today.

### Pros

- **Reaches iCIMS without aplyx touching iCIMS.** aplyx would be a
  consumer of freehire's aggregate, not a scraper of iCIMS itself — the
  ToS problem `docs/icims-automation-research.md` identified is freehire's
  to have, not aplyx's (see Cons below for the caveat on this).
- **One integration instead of N.** Adzuna, Telegram-sourced boards, and
  30 direct company feeds all arrive through the same interface as ATS
  boards, with no bespoke fetcher per source.
- **Free and keyless** at the level aplyx would use it (no billing
  integration to build, unlike the OpenCode-balance problem this repo just
  hit).
- **MCP-native**: no new plumbing pattern — aplyx already runs Playwright
  as an MCP server (`.mcp.json`), so adding a second MCP server is
  operationally familiar, not a new category of thing.
- **Self-hostable if the hosted instance ever becomes unreliable or rate
  limits change** (Docker Compose + Postgres, full source available) —
  an exit ramp exists if needed, unlike a closed-source aggregator.
- **`/agent/jobs/search` returning full descriptions** matches exactly
  what aplyx's fit gate needs (it fit-gates on JD text), rather than
  requiring a second per-job detail fetch the way Workday listings do
  today (Workday's list endpoint carries no JD text and needs a follow-up
  fetch per candidate).

### Cons

- **Third-party dependency for a core pipeline step.** If freehire's
  hosted service goes down, changes its API, or shuts down, job-scraper's
  reach silently shrinks back to today's direct-API boards. aplyx has no
  control over freehire's uptime or roadmap.
- **Using freehire to reach iCIMS doesn't make the ToS question
  disappear, it moves it.** freehire's own scraping/aggregation practices
  and its own terms of service for downstream reuse haven't been reviewed
  here — "aplyx isn't the one scraping iCIMS" is true, but if freehire's
  own terms restrict automated reuse for job-application purposes at
  scale, routing through them doesn't clear that; it needs its own check
  before this is treated as a solved problem, not assumed clear because
  the request path looks indirect.
- **Data freshness/accuracy is now someone else's crawler.** aplyx's
  direct-API fetchers (Ashby/Lever/Greenhouse) hit the ATS's own live data;
  freehire's postings are only as fresh and accurate as its own crawl
  cadence and dedup logic, which aplyx can't verify or control.
  Duplicate/stale postings from an aggregator could waste fit-gate calls
  or produce a Discord report on a job that's already closed upstream.
  aplyx already dedupes against its own history, but not against
  "already gone from the source" the way a direct API's own listing
  naturally would be.
- **New moving part in `AGENTS.md`'s "which fetch method for which board"
  contract.** The behavioral rules would need an explicit new clause
  (when to prefer freehire vs. a direct-API fetcher for a board that has
  both), or job-scraper risks double-counting the same posting from two
  sources.
- **Unverified at aplyx's actual scale.** Nothing here has tested rate
  limits, latency, or result quality against aplyx's real target list —
  this whole section is desk research from the public docs, not a spike.

### Open question

Do we add freehire's MCP server to `.mcp.json` now, run a scoped spike
first (a handful of `ashby_company_slugs`-style targets, compare
freehire's results against the existing direct fetchers before trusting it
for iCIMS/Adzuna coverage), or hold this as a noted idea? No code changes
happen until this is picked.

## Part 2: should aplyx expose its own MCP server?

### Where it would fit

aplyx already has three thin frontends over the same `@aplyx/core` logic:
the Tauri desktop bridge (stdio subprocess, JSON in/out), the Ink TUI
(shells out to the same helpers), and the harness's own direct Bash calls
into the Python state helpers. An MCP server would be a fourth: the same
core read functions (`getSchedulerStatus`, resume listing, review-queue
reads, registry reads, applied-jobs reads), wrapped as MCP tools any
client can call. It costs nothing new to build in the sense that it calls
functions that already exist — the work is the wrapper and the tool
schema, not new business logic, matching this project's "core owns logic,
frontends call it" convention (`CLAUDE.md` repo map).

### Where it wouldn't help

Using MCP *internally* — the orchestrator calling its own helpers through
an MCP tool instead of the Bash it uses today. MCP's value is cross-client
interoperability; a single first-party harness with direct Bash access
gains nothing from that indirection, it would just be new formalism
wrapped around something that already works.

### The real risk: read vs. write

aplyx also has *mutating* actions — `approve_submit`, `dismiss_queue_entry`,
triggering a real application run. Exposing those as MCP tools means any
MCP client with access could trigger a real job application on the user's
behalf. That's a materially different safety commitment than "read my
dashboard from chat": today there's no rate limit, no confirmation step,
and no audit trail built for an external caller triggering a submission —
only for the app's own UI-driven flows. This mirrors the same fail-closed
posture the Workday verification checkpoint and `approve_submit_*.py`
scripts already take (`AGENTS.md`, "Conventions that trip people up").

### Recommendation

A **read-only** local MCP server (stdio, same pattern as the existing
Playwright MCP entry in `.mcp.json` — no network exposure) covering:

- Review queue (pending entries, same filter `ReviewScreen` uses)
- Applied-jobs history and per-outcome counts
- Job registry / pipeline breakdown
- Scheduler heartbeat status (including the new `usage_limited` flag)
- Resume list + tailoring status

Explicitly **out of scope for a first pass**: anything that writes —
`approve_submit`, `dismiss_queue_entry`, triggering a run, editing profile
fields. If write tools are wanted later, that needs its own design pass
(confirmation flow, rate limiting, audit trail) before it's safe to ship,
not a checkbox added to the read-only server.

### Open question

Build the read-only version now, or hold this as a noted idea? If yes:
does it ship as a feature of the desktop app (bundled, started alongside
it) or a standalone binary a user runs separately? Not decided here.
