# MCP servers in aplyx: consuming freehire, and aplyx owning its own

> **Status (2026-09-12): Part 1 (freehire) approved and built — as a
> direct API fetcher, not an MCP server. Part 2 (aplyx's own MCP server)
> approved in direction, not yet built.** Operator approved freehire
> conditionally ("if it gives more jobs") and confirmed Part 2 is meant
> literally: aplyx exposing an MCP server for other AI agents to use, not
> just a nice-to-have alternative. See each part below for what changed
> from the original draft.

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

### Decision and what actually got built (2026-09-12)

Approved, conditional on it surfacing net-new jobs — confirmed live
before shipping: a real `--search "software engineer intern"` call
against freehire's public API returned a mix including `mycareersfuture`,
`adzuna`, `whatjobs-in`, and `avature` postings alongside `ashby`/
`greenhouse`/`workday` ones aplyx already reaches directly — genuinely new
boards, not just duplicates of what aplyx already had.

**Built as a direct API fetcher, not an MCP server** — `.mcp.json` was
never touched. freehire's own docs frame the MCP server as the
integration path, but aplyx's own established pattern for exactly this
shape of source (a company-agnostic aggregator: see Muse/Amazon/Oracle)
is a small deterministic Python helper called directly by `job-scraper`,
not an agent-driven MCP tool call — this is a plain data fetch with no
judgment involved, so the MCP layer would have added indirection without
benefit. `src/scripts/jobs/fetch_freehire_listings.py`, wired into
`src/agents/bodies/job-scraper.md` as step 3l, toggled via `"freehire"`
in `targets.json` "boards" (same convention as amazon/apple/muse).

**Two documented API filters turned out broken when tested live**:
`seniority=intern` is silently ignored (`ignored_params` in the response)
and ties to `q` return zero results; `is_tech=true` per the docs' stated
boolean type also zeroes results (`is_tech=tech`, the enrichment field's
own string value, does work, but was left unused to avoid unverified
narrowing away from aplyx's security/network role_keywords). The fetcher
instead sends the same `--search` query job-scraper already builds for
role/level prefiltering (step 0/8) as freehire's real `q` full-text param
— confirmed this alone returns well-targeted, correctly
`enrichment.seniority`-tagged results without needing the broken filters.

**Source attribution, the operator's explicit condition**: freehire's own
response already tags each posting with the real underlying board in its
`source` field (`workday`, `ashby`, `greenhouse`, `adzuna`, `avature`,
`mycareersfuture`, etc.) — confirmed live, not assumed. The fetcher passes
that value straight through as aplyx's own canonical `source`; the
literal string `"freehire"` is never written anywhere (registry, Discord
report, applied_jobs.json), only used as a defensive fallback if a
response ever omits the field.

**Dedup**: no new logic needed, as the "Part 1: freehire as a source"
analysis above predicted. freehire preserves the real employer ATS URL
(appending only `?utm_source=freehire.me`), and `normalize_url()` already
strips `utm_*` params — so a posting also reachable through a direct
fetcher (e.g. a company in both `greenhouse_company_slugs` and freehire's
coverage) produces the identical `job_key` from either source. The
natural-key fallback remains the safety net for cases where it doesn't
(freehire-only postings, or a URL shape normalize_url doesn't fully
collapse).

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

### Decision (2026-09-12) and what got built

Approved, and confirmed the operator means this literally: an MCP server
aplyx owns, for other AI agents (any MCP client — Claude Desktop, Claude
Code, Cursor, etc.) to use directly, not just a hypothetical alternative
to the freehire discussion. Built the read-only version as scoped above —
write tools (`approve_submit`, `dismiss_queue_entry`, triggering a run)
stay explicitly out, per the safety reasoning above, until they get their
own design pass.

`src/mcp-server/` — a new npm-workspace package (`@aplyx/mcp-server`),
depending on `@aplyx/core` the same way the Tauri bridge and TUI already
do (no new business logic, just tool wrappers over existing functions:
`loadState`, `isResolved`, `registryByJobId`, `listResumeFiles`,
`getSchedulerStatus`). Ships as a standalone local stdio server (`bin:
aplyx-mcp`) rather than bundled into the desktop app — an MCP client
launches it directly, independent of whether the desktop app is running.
Smoke-tested live via a real stdio JSON-RPC handshake against the
operator's actual checkout: `tools/list` and four `tools/call`s round-
tripped correctly, including `get_scheduler_status` correctly surfacing
the `usage_limited: true` flag from the still-ongoing OpenCode balance
issue.

**Tools exposed** (all read-only, all take an optional `root` argument,
default `$APLYX_ROOT` then auto-detection):

| Tool | Returns |
|---|---|
| `list_review_queue` | Pending (unresolved) review-queue entries |
| `list_applied_jobs` | Applied-jobs history, optionally filtered by status |
| `get_pipeline_status` | Registry breakdown by fit-gate outcome |
| `get_job_detail` | One job's registry record by `job_id` |
| `get_scheduler_status` | Scheduler heartbeat, incl. `usage_limited` |
| `list_resumes` | Base resume files + conversion status |

**Wiring it up to a client** — nothing in aplyx auto-registers this; a
user adds it to their own MCP client config, e.g. Claude Code's
`.mcp.json`:

```json
{
  "mcpServers": {
    "aplyx": {
      "command": "node",
      "args": ["/absolute/path/to/aplyx/src/mcp-server/dist/index.js"],
      "env": { "APLYX_ROOT": "/absolute/path/to/aplyx" }
    }
  }
}
```

**Not done in this pass**: no `docs/SETUP.md` walkthrough for end users,
no packaging/publishing (it currently only runs from a built checkout,
`npm run build --workspace=@aplyx/mcp-server`), and no automated tests —
consistent with this repo's existing convention for thin API-wrapper
scripts (verified live instead; see `fetch_freehire_listings.py`'s own
docstring for the same posture). Add these if this is meant to reach
users beyond the operator's own checkout.
