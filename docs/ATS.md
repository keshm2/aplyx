# aplyx ATS and careers-source plan

This document is the durable reference for aplyx's ATS and job-source
expansion work.

It exists so the source-expansion phase does not depend on scattered research
notes, transient competitor scans, or status summaries in other docs.

## Purpose

aplyx needs stronger discovery breadth and faster first-seen pickup for new
jobs.

The strategy is:

- prefer deterministic employer-owned/public feeds over generic scraping
- treat big-company custom careers systems as first-class work, not as edge
  cases
- expand the ATS matrix based on what competitors actually support in the
  market
- separate **implemented**, **verified but deferred**, and **researched but too
  fragile** sources clearly

## Current implemented sources

These are already in the product or in the current source-expansion phase.

### Core ATS/public sources already shipped

- **Ashby**
- **Lever**
- **Greenhouse**
- **Workday CXS** (review-first / JD-enrichment path)
- **SmartRecruiters**

### Company-specific / custom boards already shipped

- **Amazon**
  - public JSON search endpoint
  - full JD text available in the list response
- **Oracle Recruiting Cloud (ORC)**
  - reusable tenant-based Oracle Recruiting Cloud path, not just Oracle-the-company

## Competitor-derived ATS matrix

These systems repeatedly show up across competitors such as Tsenta,
Simplify, Jobright, ApplyCove, LoopCV, Open Applier, JobWizard, Lentra,
Jobaholic, and related tools.

### High-priority recurring ATS/careers systems

- Workday
- Greenhouse
- Lever
- Ashby
- iCIMS
- SmartRecruiters
- Taleo / Oracle
- Workable
- Jobvite
- BambooHR
- Rippling
- JazzHR (added 2026-08-10; confirmed present in Tsenta's own claimed
  matrix, see the 2026-08-10 research pass below; previously missing from
  this list entirely)
- Breezy / BreezyHR (added 2026-08-10, same source)

This is the practical market-backed ATS matrix for aplyx.

## Big-company / custom careers systems

Not every important employer is cleanly covered by an ATS adapter.

These companies or company classes need dedicated thought because they either:

- sit behind custom public job surfaces
- lightly wrap an ATS with a branded shell
- expose useful public endpoints that are not obvious from the page alone

### Highest-value custom/company-specific targets

- **Microsoft**
  - current public `apply.careers.microsoft.com/api/pcsx/search` JSON search
    API
  - likely worth targeting early because it is deterministic and high-signal
- **American Express**
  - appears to sit on Oracle Candidate Experience / Oracle Recruiting Cloud
  - likely a tenant-discovery / Oracle generalization problem, not a special
    one-off integration
- **Salesforce**
  - Workday CXS tenant path
  - should usually be handled by better tenant discovery on existing Workday
    support
- **Nvidia**
  - Workday CXS tenant path
  - same class as Salesforce
- **Datadog**
  - branded site, but underlying jobs resolve to Greenhouse
  - better handled by stronger Greenhouse slug discovery than by a custom adapter
- **Palantir**
  - branded site, underlying Lever path
  - same class as Datadog but for Lever
- **OpenAI**
  - branded careers page, underlying Ashby application path
  - same class as Datadog/Palantir but for Ashby
- **Apple**
  - server-rendered HTML search surface worth a deterministic HTML adapter
- **Stripe**
  - server-rendered HTML jobs search surface worth a deterministic HTML adapter

### High-value but fragile targets

- **Google Careers**
  - no clean public API found
  - exposed data appears to come from a brittle internal embedded-data format
  - should only be implemented if aplyx explicitly accepts parser fragility or
    a browser-assisted fetch path
- **Meta Careers**
  - GraphQL-based public surface exists in community scrapers
  - repeated `doc_id` churn and request-shape fragility make it high
    maintenance
- **Tesla / TikTok / similar anti-bot-heavy custom systems**
  - worth researching later, but not good first deterministic targets

## Recommended priority order

### Immediate next targets

1. **Microsoft PCSX / Eightfold-style search**
2. **Expand Oracle Recruiting Cloud tenant discovery**
   - American Express
   - JPMorgan-style ORC tenants
   - other large ORC employers
3. **Expand Workday tenant discovery**
   - Salesforce
   - Nvidia
   - other large Workday employers
4. **Apple HTML adapter**
5. **Stripe HTML adapter**

### Strengthen existing ATS discovery before writing custom scrapers

For branded sites that actually resolve to standard ATS systems, improve:

- Greenhouse slug discovery
- Lever slug discovery
- Ashby board discovery

This is the right path for companies like:

- Datadog
- Palantir
- OpenAI
- similar custom-front-end / standard-ATS-back-end employers

### Later / gated targets

- Google
- Meta
- Tesla
- TikTok / ByteDance

These should be behind explicit health checks and maintenance acceptance,
not treated as normal deterministic adapters.

## Daily ingestion strategy

The difference between seeing a job early and seeing it late is often the
difference between getting reviewed and getting buried.

### Polling priorities

#### Poll most often

- employer-owned public ATS feeds
- high-signal company-specific APIs
- top watched company career pages with deterministic endpoints

Recommended cadence for high-value public feeds:

- **hourly** for high-value deterministic ATS/company APIs
- **every few hours** for medium-confidence but stable sources
- **daily** for slower-moving or backfill sources

#### Lower-frequency sources

- monthly / low-freshness public datasets
- broad backfill feeds
- low-confidence custom surfaces that are expensive to maintain

### What to store per job/source

Every discovered posting should carry enough provenance for debugging,
trust, and future scoring.

Minimum metadata:

- `source`
- `origin_url`
- `first_seen_at`
- `last_seen_at`
- source class (`ats`, `company_board`, `review_only`, `html_adapter`, etc.)
- tenant / slug where relevant
- whether JD text was complete in the list response or required enrichment

## Source classes

Use these classes to keep the roadmap and implementation honest.

### Class 1: Direct / public structured feeds

Examples:

- Greenhouse
- Lever
- Ashby
- SmartRecruiters
- Microsoft PCSX (if stable in practice)
- Oracle Recruiting Cloud tenants (when verified)

Best properties:

- deterministic
- easy to diff/validate
- low parser churn
- best candidates for frequent polling

### Class 2: Tenantized but still structured

Examples:

- Workday CXS
- Oracle Recruiting Cloud

Properties:

- strong value
- higher tenant-discovery burden
- often need JD enrichment/detail fetches

### Class 3: Branded front-end / standard ATS back-end

Examples:

- Datadog -> Greenhouse
- Palantir -> Lever
- OpenAI -> Ashby
- Stripe -> Greenhouse (moved here 2026-08-10; see the dated entry
  below; was originally miscategorized as Class 4)

Best strategy:

- improve ATS board discovery rather than writing a new custom scraper for
  each branded page

### Class 4: Branded HTML adapters

Examples:

- Apple

Properties:

- deterministic enough if the HTML is stable
- more maintenance than a public JSON/XML feed
- still much better than full browser automation if static HTML is enough

### Class 5: Fragile internal app surfaces

Examples:

- Google
- Meta

Properties:

- possible, but expensive in maintenance and validation
- should be gated and health-checked
- should not block the broader source-expansion phase

## What to avoid

- LinkedIn and Indeed scraping in this phase
- generic HTML scraping as the default strategy
- pretending every big company is “just another ATS adapter”
- implementing competitor-claimed ATS support without validating the real
  public job/data path
- taking on fragile custom systems too early while cleaner sources remain

## Validation rules before shipping a new source

Before a source is considered shipped:

1. list fetch works on real live postings
2. canonicalization yields stable `job_id` / `ats_system`
3. fit gate runs on real or properly enriched JD text
4. failures degrade to explicit warnings or review-only behavior
5. source-specific assumptions are written down

For custom/company-specific sources, also verify:

6. the public path is stable enough for repeated polling
7. a company-specific adapter is truly needed, rather than a better ATS slug/
   tenant discovery improvement

## 2026-08-08 research pass: big-company tenant coverage gap

Operator-prompted: "we don't even have JPMC or Capital One." Investigated
both plus a handful of other large employers by fetching their public
careers-site HTML/APIs directly (same technique documented above for
Oracle/careers.oracle.com) rather than assuming they need new adapters.

**Finding: this was a registry gap, not a capability gap.** Both
companies already sit on ATS systems aplyx has shipped adapters for; they were simply never added to any tenant list.

### Verified live and added to this operator's `targets.json`

- **JPMorgan Chase**: Oracle Recruiting Cloud,
  `jpmc.fa.oraclecloud.com/CX_1001`. Re-confirmed live 2026-08-08 (7,447
  total reqs via `recruitingCEJobRequisitions`), matching the tenant
  string already documented in `targets.example.json` and
  `research-notes.md` from 2026-07-25. Oracle tenants go through the
  full auto-apply path, not review-only.
- **Capital One**: Workday, `capitalone.wd12.myworkdayjobs.com/Capital_One`.
  Found directly in `capitalonecareers.com`'s server-rendered HTML (a
  `/login` link under that host); no browser needed. Confirmed live via
  the CXS `POST .../wday/cxs/capitalone/Capital_One/jobs` endpoint: 669
  total reqs. **Workday tenants now auto-apply (phase 7D, 2026-08-28)**;
  the prior review-only policy was lifted; Capital One postings tailor
  and apply via the deterministic local Workday runtime like every other
  family, stopping at the `awaiting_verification` checkpoint on the
  scheduled path until the user supplies the verification link/OTP via
  Continue Workday (the local harness has no inbox service to retrieve
  it automatically). See `AGENTS.md`'s Workday entry and §3.18B.
- **Mastercard** (found opportunistically, not requested); Workday,
  `mastercard.wd1.myworkdayjobs.com/CorporateCareers`. Same HTML-recon
  technique (careers.mastercard.com's raw HTML links straight to it).
  Confirmed live: 765 total reqs.

### Leads found, not yet confirmed (do not add to any tenant list until verified)

- **Citi**: raw HTML on `jobs.citi.com` references both
  `citi.eightfold.ai/careers` and a Workday tenant
  (`citi.wd5.myworkdayjobs.com`, site name literally `"2"`). A guessed
  Eightfold PCSX-style query 403'd ("Not authorized for PCSX"); needs
  `fetch_eightfold_listings.py`'s own dual-endpoint logic run against it
  by hand, not a hand-guessed URL, before it's trusted.
- **Bank of America**: `careers.bankofamerica.com`'s HTML references
  both `ghr.wd1.myworkdayjobs.com/lateral-us` (the site name strongly
  suggests experienced/lateral hires only, not campus/intern reqs) and
  `bac.avature.net` (a guessed `/careers/SearchJobs` path 403'd; real
  endpoint unresearched). If BofA's intern/new-grad reqs live on the
  Avature tenant rather than the lateral-only Workday one, Workday
  support alone would not surface them.

### The actual systemic gap

Greenhouse/Lever/Ashby/SmartRecruiters each have a project-owned
`*_vetted_slugs.json` registry (see "Validation rules" above) and get
bulk-discovered automatically from the SimplifyJobs community feed
(`discovered_companies.json`, 1,619 companies as of 2026-07-15). **Workday,
Oracle Recruiting Cloud, and Eightfold have no equivalent registry**; every tenant added so far (Oracle's own, American Express, JPMorgan
Chase, Salesforce, Nvidia, Microsoft, Netflix, and now Capital One/
Mastercard above) exists only as a one-off example string in
`targets.example.json`'s `_help` text or a user's own live config. There
is no systematic discovery process for these three tenant-based systems
the way there is for the slug-based ATSs, which is the real reason
large enterprise employers keep turning up "missing" one at a time
instead of arriving in bulk.

**Also newly identified: Avature is a distinct ATS with zero adapter
support today**, not previously listed anywhere in this document's
competitor-derived matrix. It showed up at Bank of America for what
looks like campus/intern-specific recruiting, exactly aplyx's target
audience, in a single small research pass. Likely present at other
large enterprises for the same reason (a separate campus-recruiting tool
sitting alongside a lateral-hire Workday/Oracle tenant is a common
enterprise pattern, not unique to BofA).

### Proposed next phase items (items 1-2 done 2026-08-31: Workday and Oracle both now have vetted registries at scale; items 3-4 not started: need operator go-ahead per phase discipline)

1. **Workday and Oracle registries built (2026-08-30/31).** A
   `workday_vetted_tenants.json` / `oracle_vetted_tenants.json` /
   `eightfold_vetted_tenants.json` registry was proposed here, same shape
   and validation discipline as the existing `*_vetted_slugs.json` files.
   Both the Workday and Oracle pieces are now built:
   `src/config/workday_vetted_tenants.json` (2026-08-30) and the new
   `src/config/oracle_vetted_tenants.json` (2026-08-31) both exist, each
   wired into `seed_vetted_slugs.py`'s `SOURCES` so a fresh install
   auto-seeds both exactly like every other board; "add a company" is a
   registry PR instead of a fresh research pass, for both tenant-based
   systems now. Eightfold's registry remains unbuilt; out of scope for
   this pass.
2. **Done (2026-08-31); dedicated research pass across large employers**
   (banks, Fortune 500 tech/healthcare/retail, defense/aerospace) seeded
   both registries at scale, using the same HTML-recon/search technique
   documented above (fetch the public careers page, or search "<company>
   myworkdayjobs.com" / "<company> oraclecloud.com careers", for a direct
   tenant-hostname link) plus targeted WebSearch queries. Every candidate
   was verified live via the real fetch helpers before being added; none
   were guessed and shipped unverified. `workday_vetted_tenants.json`
   grew from 4 to 52 tenants: Citigroup, Wells Fargo, PNC, U.S. Bank,
   Morgan Stanley (a hit this time; the 2026-08-08 pass's "no hits"
   finding was JS-rendering getting in the way of a plain page fetch, not
   an absence of a tenant), Visa, Truist, State Street, Northrop Grumman,
   RTX, GDIT, Leidos, Booz Allen Hamilton, Boeing, Adobe, Cisco, Micron,
   HP, Autodesk, Analog Devices, Applied Materials, KLA, Broadcom,
   Elevance Health, Pfizer, Merck, Bristol Myers Squibb, Johnson &
   Johnson, Gilead Sciences, CVS Health, Cigna, Amgen, Humana, Nike, Home
   Depot, Lowe's, Target, TJX, Gap Inc, Kohl's, Southwest Airlines, UPS,
   AT&T, Verizon, Comcast, GE Aerospace, 3M, and Caterpillar. `oracle_
   vetted_tenants.json` grew from nonexistent to 11 tenants beyond
   Oracle-itself/JPMorgan Chase: American Express (confirming this doc's
   2026-08-08 lead), Marriott, Hilton, Caesars Entertainment, CSX,
   Sherwin-Williams, Emerson Electric, ADT, Albertsons, Molina
   Healthcare, and Goldman Sachs. All 52 Workday and all 13 Oracle
   tenants were re-verified together against the live `targets.json`
   at the end of this pass: `fetch_workday_listings: complete tenants=52
   jobs=4621 failed=0`; `fetch_oracle_listings: complete tenants=13
   jobs=2461 failed=0`. Notable discards (a lead was found but failed
   real verification, so nothing was added): Discover Financial (401,
   likely deactivated post-Capital One acquisition), Qualcomm/Dell/
   VMware/Eli Lilly (Workday hostnames found but returned 0 jobs or
   422; apparently migrated off Workday or folded into another
   tenant), FedEx (the tenant is live but every US-specific site name
   tried returns 0 jobs), and several Oracle name-collision false
   positives caught before being added; PPG (hit was actually
   "PPECB"), Norfolk Southern (hit was "Norfolk County Council", UK),
   Dover Corporation (hit was "Port of Dover", UK), Regions Financial
   (hit was "Regions Hospital"), Eaton Corporation (hits were unrelated
   Langham Hospitality/Tumi locations), and Parker Hannifin (the
   matching tenant resolved to a senior-care health system also named
   "Parker", not the manufacturer).
3. **Avature adapter research**: determine whether a public,
   unauthenticated postings endpoint exists (same validation bar as
   every other adapter in this doc) before committing to build one.
4. **Resolve the Citi/BofA leads above** with the existing helpers
   rather than hand-guessed URLs, before adding either to any tenant
   list. (Citi's Workday lead from that pass, `citi.wd5.myworkdayjobs.com`
   site "2", is now separately confirmed and added above as part of
   item 2's Workday expansion; BofA's Avature lead is still unresolved
   and depends on item 3.)

## 2026-08-09 research pass: maximizing company count: swelist, more trackers, and "every company" boards

Operator-prompted follow-up: look at the `swelist` PyPI package, and
research more broadly how to get the most companies, including "job
boards that post every single company."

### swelist: dead end, confirmed twice

`swelist` (PyPI, MIT-licensed CLI, latest version 0.1.10, released
2026-07-12) is not a broader data source; it is a thin wrapper around
the *same* SimplifyJobs feeds this project already fetches, hardcoded to
last year's repo (`SimplifyJobs/Summer2025-Internships`, not the current
cycle). Confirmed two independent ways: (1) reading `main.py` directly
from the downloaded wheel; the URL and the printed label
`"Found {n} tech internships from 2025Summer-Internships"` are both
hardcoded; (2) the PyPI project page's own example output shows the same
`"2025Summer-Internships"` string. The "2026" the operator saw was very
likely the project's marketing framing ("for 2026 job seekers"), not the
underlying data year. Its `tracker`/`report`/`jobgpt` subcommands are a
personal local application tracker (SQLite) and an experimental OpenAI-
backed helper script; unrelated to job discovery. Not worth building on.

### What actually shipped this pass (see CHANGELOG for the full diff)

- **A second, independently-scraped community tracker added as a live
  source**: `vanshb03/Summer2027-Internships` +
  `vanshb03/New-Grad-2027`; shares the SimplifyJobs listings.json
  schema (a de facto convention across this whole tracker ecosystem) but
  is a different bot/maintainer with a different entry count, confirmed
  live 2026-08-09 (12 sample jobs fetched end-to-end through
  `fetch_simplify_listings.py`, half from each tracker, correctly
  provenance-tagged `"source": "simplify"` vs. `"source": "vanshb03"`).
  Wired into both the live runtime fetcher and
  `build_discovered_companies.py`: companies pool 1,619 → 2,615 combined
  with the 2026-08-08 pass's zshah101 addition.
- **Repo-rename hardening**: this whole ecosystem renames its repo for
  every hiring cycle (`...Summer2026-Internships` →
  `...Summer2027-Internships`, confirmed via the GitHub API; same repo
  ID, a 301 redirect on the old name). aplyx's own `fetch_simplify_listings.py`
  was still pointed at the old name; GitHub's redirect meant it wasn't
  silently broken, but it was one org-level rename away from becoming so.
  Repointed at the current canonical name.

### Bigger sources found, not yet integrated (need more work before shipping)

- **`speedyapply/2027-SWE-College-Jobs` (8,721 stars) and
  `2027-AI-College-Jobs` (6,069 stars)**; the most-starred trackers in
  this entire space, well ahead of SimplifyJobs' own 46,135-star repo in
  relative growth. **Not a static JSON file in the repo**: the actual
  data lives in a Supabase-backed pipeline
  (`.github/scripts/src/supabase.ts`, `get-jobs.ts`); the repo itself
  only holds scraper code and large rendered Markdown tables
  (`NEW_GRAD_USA.md`, 185KB). Integrating this needs finding a real
  public read endpoint (their own site's frontend almost certainly calls
  one) rather than parsing a 185KB Markdown table; a follow-up research
  task, not a data refresh.
- **`negarprh/Canadian-Tech-Internships-2026` (974 stars)**: directly
  in scope (`docs/PLAN.md` §3.18A is explicitly "US/Canada-first"), but
  it's a manually-curated Markdown table with no JSON export (`.github/
  scripts/check_closed_jobs.py` exists but operates on the Markdown
  table directly, not a separate data file). Parseable, but crosses into
  the same "generic scraping of unstructured text" class this project's
  own stated bias avoids by default; worth a dedicated look, not a
  same-pattern extension of the JSON-based sources above.
- Also surfaced, out of scope for this pass: `LorenzoLaCorte/
  european-tech-internships-2026` (777 stars, Europe),
  `didtheyghostme/Singapore-Summer2026-TechInternships` (65 stars),
  `hiba-wajeeh/2026-Tech-Internships-Australia` (16 stars); regional
  trackers outside this project's current US/Canada scope.

### The "every single company" question: a real structural option, not decided here

The operator's framing ("job boards that post every single company")
points at something categorically different from adding one more
community tracker: **schema.org `JobPosting` structured data**. Most ATS
platforms and many custom careers pages embed a `<script
type="application/ld+json">` `JobPosting` block on every posting page
specifically because Google requires it for Google for Jobs indexing; this is *why* Google's own job search can aggregate postings from nearly
every employer regardless of ATS. In principle this is the actual
mechanism behind "every company," not any specific curated list.

This is deliberately flagged rather than built: `AGENTS.md`'s and this
doc's own standing bias explicitly avoids "generic HTML scraping as the
default strategy," and while JSON-LD extraction is far more deterministic
than visual-layout scraping (one standardized structured block, not
page-layout parsing), it's still a philosophy shift from "vetted
per-ATS adapters" toward "parse whatever structured data a company's
page happens to expose." That trade-off is the operator's call, not
something to decide by building it unannounced. General job-aggregator
APIs (Adzuna, The Muse, Jooble, Careerjet) were also considered; these
skew toward full-time/professional listings with weaker internship-
specific taxonomy than the community trackers already in use, and were
not pursued further this pass; LinkedIn/Indeed/Wellfound/Handshake
(already Playwright-scraped per `AGENTS.md`) already cover a large
fraction of "every US employer posts here at minimum" in practice today,
via a different mechanism (live browser scraping, not a registry).

## 2026-08-10: The Muse adapter, and cross-source duplicate results

Operator-directed: add The Muse (from the 2026-08-09 research pass; free, public, no-login, native `level=Internship` filtering, confirmed
live), and fix duplicate results when the same real posting is
discoverable through more than one source.

### The Muse: shipped

`src/scripts/jobs/fetch_muse_listings.py`, wired into `job-scraper.md`
step 3i, `targets.json`/`targets.example.json` `"boards"` (plain
board-name toggle, same convention as amazon/apple/stripe/google; The
Muse is an aggregator across many employers, not a multi-tenant ATS with
a slug list), and both TUI/desktop manual search (8th toggleable
source). Full JD text ships in the list response, same as Amazon; no
separate detail fetch needed.

Scoped deliberately narrower than "everything the API returns", based on
live verification: `level=Internship` only (Entry Level was confirmed
absurdly noisy; "Software Engineering" + "Entry Level" alone is 1,518
pages / ~30,360 jobs, a strong signal the tag is applied far more
loosely than "actually entry-level"), across four verified-non-empty
categories (Software Engineering, Data and Analytics, Science and
Engineering, Product Management; "IT" and "Data Science" are not real
category values on this API despite appearing in some third-party docs,
confirmed by testing them directly: 0 results, not an error).

A Muse job's `url` is Muse's own landing page, not the employer's real
ATS URL; so its `ats_system` stays unresolved after canonicalize, the
same class as "simplify"/"vanshb03". This is fine: the apply pipeline's
Playwright-driven fill flow isn't ATS-specific to begin with (per
`AGENTS.md` "Fill records"; the one deliberate ATS-specific carve-out
in the whole apply path was Workday's no-auto-apply rule, lifted in
phase 7D, 2026-08-28), so it clicks through a Muse landing page's real Apply
button the same way it would navigate any other job's `url`.

### Cross-source duplicate results: fixed at the search/display layer, not the state layer

The concrete failure mode: the same real posting (e.g. a SpaceX
internship) discoverable through The Muse AND a direct ATS source
resolves to two *different* URLs; Muse links its own landing page, the
direct source links the real Ashby/Lever/Greenhouse/etc. posting; so
the manual Search screen's old dedup (`jobs.ts`'s `searchJobs`, exact
`job.url` string equality) showed it twice.

Fixed with a normalized-(company, title, location) composite key
(`dedupeKey` in `src/core/src/jobsSort.ts`, wired into `searchJobs`):
strips legal-entity suffixes from the company ("SpaceX Inc." ==
"SpaceX"), reuses the same word-tokenizer `titleMatchesQuery` already
uses for title comparison (so punctuation/spacing differences collapse
the same way title search already treats them), and sorts location
tokens so list-order differences don't matter. **Exact-match on the
normalized form, not fuzzy**; a false merge here just hides a result,
cheap on a display screen, but still not worth risking a
similarity-based match over. Verified live: two synthetic postings for
the same real SpaceX internship (different source, different URL,
"SpaceX" vs "SpaceX Inc.", location list in reversed order) now produce
the same key; a genuinely different SpaceX internship (different title)
does not.

The exact same normalization was also applied to
`job_state.py`'s `derive_job_key`'s natural-key fallback branch (used
only when a canonical job has neither a URL nor a source+external-id:
today, in practice, almost never, since essentially every shipped source
carries a URL), a narrow, low-risk hardening, not a fix for the general
case.

**What this does NOT fix, by design, pending an explicit decision**: the
autonomous run's state registry (`job_state.py`'s `derive_job_key`) still
keys primarily on URL identity for any job that has one, which is
almost every job. If the same real posting reaches the registry via two
sources with two different URLs (Muse's landing page vs. the real ATS
link being the exact case that motivated this fix), it can still become
*two* registry records, meaning the agent could apply to the same real
job twice across two runs, one slot each out of the 25-per-session cap.
Fixing this properly means deciding whether a natural-key match should
ever override a present-but-different URL identity for merge purposes,
a change to state-identity semantics, which is exactly the kind of
change `AGENTS.md`'s state-write discipline treats as deserving an
explicit decision, not a silent fix bundled into a display-layer bug fix.
Flagged here rather than decided here.

## 2026-08-09/10: cross-source double-apply risk closed, Oracle/Workday/Eightfold timeout fixed, Google enabled

Operator-directed: "fix all bugs", fix Oracle "always timing out" (and
other ATSes doing the same), and asked about Google Jobs coverage.

### The cross-source duplicate risk (flagged, not fixed, at the end of the previous pass): now fixed

Previously: the search/display-layer dedup fix shipped, but the deeper
state-registry risk was deliberately left open pending a decision; the
same real posting reaching the registry via two sources with two
different URLs (an aggregator's landing page vs. the employer's real ATS
link) could become two separate registry records, meaning the agent
could apply to the same real job twice across two runs.

Fixed in `job_state.py`: `upsert_job` now falls back to a normalized-
natural-key match (`_find_record_by_natural_key`) when the primary
job_key lookup misses, merging into whichever record was seen first
rather than inserting a second one. More importantly, `can_apply`; the
actual pre-submit safety recheck; gained the same natural-key fallback
as its last-checked, lowest-priority match field, so a job already
`applied`/`needs_review`/`failed`/`skipped_unfit` under a different
job_key still blocks a resubmission. Verified live with a real
three-source scenario (Muse/Ashby/vanshb03, three different URLs, same
real SpaceX posting): two sources correctly merge into one registry
record, and a third source's later sighting is blocked before re-
applying. Also verified the inverse; three genuinely distinct SpaceX
postings (different title, different location, different role_type) at
the same company correctly stay as three separate records; a job seen
twice from the *same* source still resolves via the primary job_key path
and doesn't double up either.

### Oracle "always timing out" (and Workday, Eightfold: same bug, latent)

Root cause, confirmed by direct measurement: Oracle's Fusion HCM API
costs ~1.9-2.3s per request regardless of tenant (already known and
explicitly accepted in `jobs.ts`'s own `SOURCE_DEADLINE_MS` comment,
written when there was only ever 1 oracle tenant configured). Every
multi-tenant fetcher (`fetch_oracle_listings.py`, `fetch_workday_
listings.py`, `fetch_eightfold_listings.py`) looped over its configured
tenants **sequentially**: so adding a second tenant (this operator's
own JPMC/Capital One/Mastercard additions two sessions ago) didn't add a
few hundred milliseconds, it roughly *doubled* total latency: Oracle
measured 5.06s for 2 tenants, Workday 3.52s, both far past the
interactive search's 2.2s per-source deadline. That deadline itself is a
deliberate, documented tradeoff ("Oracle... will occasionally get cut
off... an accepted tradeoff for a hard responsiveness guarantee") tuned
for *one* tenant's latency; it was not touched here, since overriding
an explicit prior design decision wasn't asked for and would trade away
the whole search's responsiveness guarantee to fix one source.

Fixed instead at the layer that actually regressed: all three fetchers
now fetch their configured tenants **concurrently** via stdlib
`concurrent.futures.ThreadPoolExecutor` (I/O-bound HTTP calls, no shared
mutable state between threads, no new dependency). Measured after the
fix: Oracle 5.06s → 2.23-2.27s, Workday 3.52s → 1.84-2.25s; back to
each source's original *single-tenant-equivalent* latency regardless of
how many tenants are configured, restoring the exact tradeoff the 2.2s
deadline was originally tuned to accept. Given real-world network
jitter, Oracle in particular can still occasionally lose the race in the
interactive search (by design, unchanged from before any tenant was
added); but this is now the pre-existing, accepted flakiness level, not
a guaranteed failure. The autonomous run (`job-scraper.md`'s pipeline)
was never affected by this deadline at all; it has no such time
constraint, so this bug only ever affected the manual Search screen's
snappiness, never the actual scheduled-run coverage.

### Google Jobs: already built, was just off

The adapter (`fetch_google_listings.py`) already exists, already works
(re-verified live: real postings with full JD text, health check
passing, ~1.9s for a 75-job fetch), and was simply never in this
operator's own `targets.json` "boards"; it's deliberately opt-in
(not in `targets.example.json`'s default board list either) given it's
the most fragile adapter in the codebase: no public API, parses Google's
unlabeled positional embedded-data format that Google could reshape
without notice (see the "High-value but fragile targets" section above).
Enabled for this operator specifically, since it's demonstrably live
right now; left out of the example template's default list, preserving
the original opt-in-for-a-reason decision for fresh installs.

## 2026-08-10: Stripe adapter rewritten (was silently broken)

Operator-directed repo-wide health check (multi-agent) caught this: the
original HTML-parsed Stripe adapter (`fetch_stripe_listings.py`) was
returning `jobs=0, failed=false` on every query; indistinguishable from
"no matching Stripe jobs right now" unless you already knew to be
suspicious. Root cause: Stripe's careers site moved from
`stripe.com/jobs/search` to `stripe.com/careers/search` (Next.js-
rendered) at some point after this adapter shipped; the old regex
looked for `<tr class="TableRow">` markup that no longer exists on the
new page.

Investigating the replacement turned up something better than a parser
rewrite: Stripe's own listings carry a `greenhouseId`, and
`boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true` returns
550 real postings with full JD text; confirmed live. Stripe is a
Class 3 (branded front-end / standard ATS back-end) source, same as
Datadog/Palantir/OpenAI, not the Class 4 (branded HTML adapter) it was
originally filed under; reclassified above. Rewrote
`fetch_stripe_listings.py` as a thin, reliable wrapper around that API
instead of either re-deriving a Next.js-data parser or migrating
"stripe" into `greenhouse_company_slugs` and retiring the file; kept
as its own file so the "stripe" board name in `targets.json` keeps
working unchanged for anyone who already has it configured. Bonus:
the new version gets full JD text directly in the list response
(confirmed live), removing the old two-step list+`--jd-url` fetch
entirely; same simpler shape as Amazon/Google/Muse.

## 2026-08-10: Tsenta competitive benchmark, iCIMS/Rippling/BambooHR/Workable/Jobvite/JazzHR/Breezy research, Workday auto-apply re-evaluation

Operator-directed: research how to apply to Workday (including its
account-creation step) and the seven remaining unshipped ATS platforms
from this doc's own matrix, sourced from Tsenta (tsenta.com), with the
explicit goal of reaching Tsenta's tier. Four parallel research passes
(one per topic below); findings consolidated here rather than left
scattered, per this doc's own stated purpose.

### Tsenta itself: what they actually are and do

Real, funded company (YC S26, $500K, two founders, ~45,000 users
claimed, unverified). Positioning: "be the first to apply to every job
that fits you"; an AI agent that monitors 50k+ career pages, tailors a
resume/cover letter per posting, and submits directly. Available as web
dashboard, mobile apps, Chrome extension, iMessage/WhatsApp, and MCP
integrations.

**Their claimed ATS matrix confirms every platform this operator
named**; Workday, iCIMS, Rippling, BambooHR, Workable, JazzHR, Jobvite,
Breezy all appear on Tsenta's own pages; plus platforms aplyx already
ships (Ashby, Greenhouse, Lever, SmartRecruiters, Oracle Cloud) and
several not yet in this doc's matrix at all: **Paylocity, UltiPro, ADP,
Dover, Gem, Zoho Recruit**, plus job-board integrations for **LinkedIn
Easy Apply, Indeed, ZipRecruiter, Dice**. Note aplyx already covers
LinkedIn and Indeed today, via a different mechanism than an ATS
adapter (`AGENTS.md`: "LinkedIn, Indeed, Handshake, Greenhouse,
Wellfound: use Playwright MCP for browser-based scraping"); that gap is
already closed, just not through this doc's ATS-matrix framing. Exact
platform count is inconsistent across Tsenta's own marketing pages
(cited as "19+", "15+", and "30+" in different places); treat as
directional, not an audited number.

**How they apply: the important technical finding.** Tsenta's own
Chrome-extension comparison page describes a hybrid model, not a pure
autofill tool and not pure opaque server automation: "logs in to the
ATS, completes every field including open-ended questions in your voice,
uploads your tailored resume and cover letter, and queues an
application in 2–3 seconds," with "two modes: live overlay or fully
headless replay capability." Two things worth flagging directly against
this project's own standards, not to copy:

1. **They generate answers to open-ended/essay questions themselves**
   ("in your voice"). aplyx's explicit, deliberate policy
   (`job-scraper.md` Phase 3) is the opposite: never invent an answer to
   a motivation/essay question; park the job and require the user's own
   pre-approved text via `interest_letter.py`. This is a real product
   difference, not a gap to close; an invented answer is a claim the
   applicant would have to defend in a real interview, and this project
   has already made the deliberate call not to fabricate one. Not
   recommending aplyx match this.
2. **Their diff-view-before-submit is the right idea and matches this
   project's own direction already**; a human confirms exact filled
   values before anything submits. This is the same "confirm-before-
   submit" pattern already proposed for hosted `auto_apply` in
   `docs/hosted-auto-apply-plan.md`'s Stage 1, and the same never-auto-
   submit contract the local browser extension already has today. Worth
   treating this convergence as validation of that design, not a new
   idea to import.

Tsenta also claims to auto-create Workday candidate accounts as part of
applying; found only via a search-engine-summarized claim, not a
primary Tsenta page directly fetched. **Unconfirmed**, flagged rather
than trusted; see the Workday section below for why this claim should
be treated with real skepticism regardless of whether Tsenta says it.

Pricing: free tier 25 apps/mo; paid $19/$39/$99 per month at
600/1,500/4,500 apps. No CAPTCHA-handling claims found anywhere. New
company (no long track record) but a real, credible one per outside
review (LoopCV: "legitimate," flags it as new with limited track
record).

### Workday: re-evaluated 2026-08-10 (review-only), then lifted 2026-08-28 (phase 7D)

The operator asked specifically about the account-creation step. Direct
research findings, not inferred from Tsenta's marketing:

- **Confirmed: a Workday candidate account (email + password + email
  verification/consent) is required to apply, and it is per-tenant, not
  global**; one account per employer, not one account usable across
  every Workday-hosted employer. Real users complain about this
  explicitly (Glassdoor, Blind threads cited in the research). This is
  the actual scaling blocker for automation: N target employers means N
  separate signup/verification flows to manage, not one.
- **Confirmed: Workday's own site terms explicitly prohibit automated
  interaction**; "develop or use any applications that interact with
  our Sites without our prior written consent," plus a direct
  data-mining/scraping prohibition
  (`workday.com/en-us/legal/site-terms.html`). This is a real, direct
  textual ToS conflict with unattended automated submission, not
  inferred risk.
- **The application form itself is long and brittle**: 5-10 pages (My
  Information → My Experience → Application Questions → Voluntary
  Disclosures → EEO Self-ID → Review/Submit), with widely-reported
  unreliable resume parsing forcing manual re-entry, and at least one
  documented bug where special characters in a work-history field can
  silently drop entered data on back-navigation.
- **CAPTCHA evidence on Workday specifically is weaker than expected**:
  not confirmed the way it is for Indeed. General anti-bot
  infrastructure (Cloudflare/Kasada-class) is documented broadly across
  job portals but not confirmed for Workday by name.
- **The market's most mature competitors; Simplify, Huntr, Careerflow,
  Teal, Jobright; all stop at autofill and hand control back to the
  user to review and click submit, even for Workday specifically.**
  Simplify reports roughly 70% field-fill success with dropdowns still
  needing manual selection. None of the researched tools do full
  unattended Workday submission; this includes tools with dedicated
  engineering investment in Workday specifically, not just casual
  attempts.

**Conclusion as of 2026-08-10: keep Workday review-only for full
auto-submit; the existing policy (`AGENTS.md`: "No auto-apply path
exists for Workday... none is planned") is well-founded, not a gap
to close.** Nothing in this research changes that call; if anything
it's stronger
evidence for it than existed when the policy was first written. The
real, buildable improvement for Workday specifically is not full
automation; it's making the **prefill-and-hand-to-human** experience as
good as possible, which the local browser extension (phase 10) already
does for Workday today (`extension_bridge.py`'s `ALLOWED_SOURCES`
already includes `"workday"`; this isn't a gap, it already exists
locally). The actual gap is that this same capability isn't available to
a hosted/no-coding-agent user yet; closing that is exactly
`docs/hosted-no-agent-tiers-plan.md`'s Tier 1 (hosted hybrid autofill),
already scoped, not something new to design here. Auto-creating a
Workday candidate account (per Tsenta's unconfirmed claim) is
deliberately **not** recommended as a near-term target: it multiplies
the per-tenant email-verification-loop problem across every configured
Workday tenant, and no research turned up confirmed evidence any
competitor; Tsenta included; does this reliably at scale rather than
claiming it in marketing copy.

**Update 2026-08-28 (phase 7D): the review-only policy was lifted.**
The 2026-08-10 conclusion above was reversed by an explicit operator
decision: Workday candidates now tailor and apply via the
deterministic local runtime `src/scripts/runtime/approve_submit_workday.py`,
which owns the per-tenant account-creation / verification / multi-step
page-fill / final-submit flow with fail-closed safety. The ToS and
per-tenant-verification findings above remain factually accurate and
explain the one real boundary that still holds: the local harness has
no inbox/alias service to retrieve the Workday verification mail/OTP,
so every Workday application checkpoints at `awaiting_verification`
on the scheduled path and the user supplies the link/OTP via Continue
Workday to cross it. That is a missing-inbox blocker, not a policy
prohibition; the runtime proceeds through login → page-fill → final
submit once the boundary is crossed. See `AGENTS.md`'s Workday entry
and `docs/PLAN.md` §3.18B for the full path.

### The seven researched ATS platforms: findings and priority

Researched for: (a) does a real public/unauthenticated JSON listing API
exist (the Greenhouse/Lever bar), (b) what the actual application flow
requires (account creation, CAPTCHA), (c) market share as a value
signal.

| Platform | Public API | Account to apply | CAPTCHA | Market signal | Verdict |
|---|---|---|---|---|---|
| **Workable** | **Confirmed, unauthenticated**: `apply.workable.com/api/v1/widget/accounts/{slug}?details=true`; the same public embeddable-widget endpoint Workable's own sites use | No: guest apply, closer to Greenhouse/Lever UX | Unconfirmed either way | SMB/startup-skewed, ~2k-11k companies (source-dependent) | **Ship first**: same tier of effort as Greenhouse/Lever |
| **BambooHR** | Quasi-public internal endpoint powers `<company>.bamboohr.com/careers`, reachable without auth headers but **undocumented and reported unstable** (shape changes without notice); the *official* documented API is token-gated | No strong evidence of a mandatory account | Unconfirmed | SMB, thousands of companies, mostly <100 employees | Worth a live spike to check real stability before committing; not as safe a bet as Workable |
| **JazzHR** | No open JSON API (Apply API is bearer-token/partner-gated); but job data appears **embedded server-side in career-page HTML** at `<company>.applytojob.com/apply/jobs`, making a Class-4-style HTML adapter (same class as Apple) more viable than an API call | **No**: single-page, no account, resume drag-drop with auto-parse | **Confirmed to exist as a per-customer toggle**: some companies enable it, some don't | SMB, ~16,700 companies confirmed, 60% small business | HTML-adapter candidate, most tractable of the harder group |
| **iCIMS** | No confirmed free API: internal endpoint undocumented/unstable, official Search/Job-Portal API is **partner-gated** (needs customer sponsorship, not open registration) | Yes: candidate portal account; guest-apply exists but forfeits status tracking | Reported (weaker sourcing: one blog title found, page itself unreachable) | **#1 enterprise ATS by market share** (~11%, ~25% of Fortune 500, ~12,000 companies) | High value, hard to build; gated + CAPTCHA risk; a scraping/Playwright approach, not a clean adapter, if pursued at all |
| **Jobvite** | No: feed is **opt-in per customer contract**, off by default | Yes: full account with email verification, multi-step form | Unconfirmed directly; one open-source apply-bot project lists it as automatable with friction | Mid-market/enterprise (Zappos, Hulu, Schneider Electric; ~4,718 companies) | Comparable difficulty to Workday; defer |
| **Rippling** | **Real, officially documented API exists** (`api.rippling.com/platform/api/ats/v1/board/{slug}/jobs`) but requires the **employer's own paid Recruiting Pro subscription plus an API key/OAuth token**: structurally gated on the customer side, not just hard to find | Unconfirmed | Unconfirmed | Large company overall (20k+ customers, $570M ARR) but newer/smaller specifically as an ATS | Structurally blocked, not a research problem to solve further; defer indefinitely absent a negotiated integration |
| **Breezy (BreezyHR)** | **Confirmed none**: Breezy's own developer docs state plainly no public API exists; third-party scraper services exist specifically to fill this gap (a real corroborating signal) | No: profile auto-created on apply, no separate account step | Unconfirmed | SMB (~13,000 companies) | Hardest of all seven to build a clean adapter for; defer |

**Recommended build order, cheapest/highest-confidence first:**

1. **Workable: shipped 2026-08-10**, see the dated entry below for the
   full write-up. Confirmed public API, no-account apply flow, same
   effort class as the existing Greenhouse/Lever adapters.
2. **JazzHR: shipped 2026-08-10**, see the dated entry below. HTML-adapter
   class (Class 4, like Apple), no account creation needed.
3. **BambooHR: next up.** A short live spike to confirm the internal endpoint's
   real stability (this doc's own "Validation rules" §6; "the public
   path is stable enough for repeated polling") before deciding to ship
   or defer.
4. **iCIMS, Jobvite, Rippling, Breezy**: defer. Each is blocked by a
   real structural gate (partner-only API access, opt-in customer
   contracts, no public API at all) rather than a research gap this
   project can close by looking harder. iCIMS is the one worth
   revisiting first among these four if reprioritized later, purely on
   market-share value (#1 enterprise ATS); but any path forward there
   is a scrape/Playwright approach against real CAPTCHA risk, not a
   clean deterministic adapter, and should be scoped and gated the same
   way Google/Meta already are in this doc's Class 5.

### Additional gap found, not part of the original ask

Tsenta's own claimed matrix also includes **Paylocity, UltiPro, ADP,
Dover, Gem, and Zoho Recruit**; none currently in this doc's
competitor-derived matrix at all. Flagged here for visibility, not
scoped or researched this pass; a candidate for a future research pass
if closing the full Tsenta-parity gap becomes the explicit goal, not
assumed in scope of this one.

### Where this leaves aplyx vs. Tsenta

Already at parity or ahead on: Ashby, Greenhouse, Lever, SmartRecruiters,
Oracle Cloud (all shipped), LinkedIn/Indeed (covered via Playwright
scraping, a different mechanism than an ATS adapter but the same
end-user coverage). Real, confirmed gaps: Workable, BambooHR, JazzHR,
iCIMS, Jobvite, Rippling, Breezy (0 of 7 shipped today); three of which
(Workable/JazzHR/BambooHR) are realistically buildable soon, four of
which (iCIMS/Jobvite/Rippling/Breezy) are gated by real structural
barriers Tsenta itself likely also has to work around (contract-gated
APIs, no public API at all) rather than a research shortcut aplyx is
missing. On Workday specifically, this research found no evidence that
Tsenta's full-auto-submit claim is more reliably solved than the rest of
the market's best (autofill-then-human-submits); parity there is
better pursued through the already-scoped hosted hybrid-autofill Tier 1
(`docs/hosted-no-agent-tiers-plan.md`) than by chasing an unattended
Workday submission Tsenta has not demonstrably solved either.

## 2026-08-10: Workable shipped

Built and verified live end-to-end (fetch → canonicalize → fit-gate),
same bar as every other Phase 16B source. Confirms the finding above:
the widget API is real; the 2026-07-21 attempt's empty results were
guessed company slugs (Revolut, Monzo, Deliveroo, Typeform, GitHub,
GitLab, Automattic), all of which either 404 or return an account with
a permanently empty `jobs` array today. **A slug guessed from a
company's public name is not reliable; the real slug is only trustworthy
when found from an actual live posting URL**
(`apply.workable.com/<slug>/j/...`), the same discovery method already
used for Oracle/Workday tenants. Found five real, currently-live slugs
this way (a web search for real `apply.workable.com` posting URLs, not
name-guessing) and verified each returns real jobs with full JD text in
the list response: `tarte-inc` (70 jobs), `quickrelease` (19),
`job-bridge-global-1` (499), `east-bank-club` (21), `powerlines` (2).

**Shipped:**
- `src/scripts/jobs/fetch_workable_listings.py`; the autonomous
  pipeline's fetcher, list-only (no `--jd-url` mode needed; full JD
  text ships in the list response, same simple shape as Amazon/Stripe/
  Google/Muse, not the two-step Workday/SmartRecruiters/Oracle
  pattern). Verified live against real accounts, real failure handling
  (a bad slug warns and is skipped, doesn't fail the whole run).
- `src/config/workable_vetted_slugs.json`; the five slugs above,
  wired into `seed_vetted_slugs.py` the same way Ashby/Lever/Greenhouse/
  SmartRecruiters already are; auto-seeds `workable_company_slugs` on a
  fresh install (or an existing install whose key is still unset).
- `job_state.py`'s ATS URL-pattern/source-map/external-id recognition,
  `job-scraper.md` step 3j, `AGENTS.md`'s source enum,
  `validate_local_config.py`/`.sh`; all extended the same way every
  prior Phase 16B source was.
- **Manual search (TUI + desktop), not just the autonomous pipeline**:
  `src/core/src/jobs.ts` gained `fetchWorkable()` (a direct `fetch()`
  call, same pattern as Ashby/Lever/Greenhouse/SmartRecruiters; no
  Python subprocess, since the API needs no pagination and returns full
  JD text in one call) and a `workable` toggle in both `SearchScreen.tsx`
  and `JobsScreen.tsx`, including `JobsScreen`'s `FAST_SOURCES` list
  (it belongs there; no Python subprocess startup cost, same fast
  fetch()-based budget as Ashby/Lever/Greenhouse/SmartRecruiters).
- Regenerated `.claude/agents/`, `.opencode/agents/`, `.github/agents/`,
  `.codex/agents/` from the updated `job-scraper.md` source.

**Deliberately not done this pass:** Workable isn't wired into the
shared `job_cache` system (`job_cache_targets.json`/
`refreshJobCache.ts`); that's a separate, larger scope decision (a
shared, multi-user cache population job) distinct from shipping the
adapter itself, not something this pass silently expanded into.

Verified: `validate_local_config.sh` passes clean with the new board
configured; `run_conformance.py --harness all` shows no new failures
(the one pre-existing `harness:claude` failure is unrelated; transcript-golden-key matching, not touched by this change); core/
TUI/desktop all typecheck clean; a live `searchJobs()` call against
real config returned `workable: {state: "ready", count: 11}` alongside
every other source.

## 2026-08-10: JazzHR shipped

Confirmed live: JazzHR has no public API (the documented Apply API is
partner-token-gated, per `apidoc.jazzhrapis.com`), but the career-page
listing at `<slug>.applytojob.com/apply/jobs` is fully server-side
rendered HTML; a Class 4 adapter, same class as Apple, not a JSON API
client. Found two real, currently-live slugs the same discovery method
as Oracle/Workday/Workable (from actual live posting URLs, never a
name guess): `empowerproject` (10 postings) and `ilsos` (Illinois
Secretary of State, 5+ postings). Both verified with real jobs, real
locations, and; a genuine bonus this codebase hasn't had from any
other list markup; a real `posted_at` timestamp embedded directly in
each row's HTML id (`row_job_<YYYYMMDDHHMMSS>_<hash>`), more precise
than most sources' list-response dates.

**Shipped:**
- `src/scripts/jobs/fetch_jazzhr_listings.py`; list mode (regex-parsed
  HTML, stdlib only, no HTML/DOM parser dependency, matching every
  other script in this directory) plus `--jd-url` mode (the list
  carries no JD text, confirmed live; same two-step pattern as Oracle/
  Workday/SmartRecruiters, unlike Workable's single-step shape). Each
  posting appears twice on the page (a desktop table and a duplicate
  "Mobile layout" section); deduped by external job id, same pattern
  `fetch_apple_listings.py` already uses for Apple's own duplicate
  anchors.
- `src/config/jazzhr_vetted_slugs.json` (2 slugs), wired into
  `seed_vetted_slugs.py`; auto-seeded into the live `targets.json`
  just now.
- `job_state.py` ATS recognition, `job-scraper.md` step 3k (regenerated
  all four harness definitions from it), `AGENTS.md`'s source enum,
  both config validators; same pattern as every prior source.

**Deliberately not done, matching Apple's own precedent exactly:**
JazzHR is NOT wired into manual search (`jobs.ts`/`SearchScreen.tsx`/
`JobsScreen.tsx`). Apple; the other Class 4 HTML adapter already
shipped; was never wired into manual search either; porting non-trivial
regex-based HTML parsing into a second language (TypeScript, for the
interactive search path) duplicates real logic for a source that isn't
a plain JSON API call the way Ashby/Lever/Greenhouse/SmartRecruiters/
Workable are. JazzHR is autonomous-pipeline-only, same as Apple and
Google, by design.

CAPTCHA: confirmed live on one tenant's apply form (`ilsos`,
`g-recaptcha` present); this is a per-tenant toggle (`empowerproject`
has none), and it never blocks reading the listing or JD (both plain
server-rendered HTML, no form interaction). It only matters at the
actual apply step, already covered by the existing generic CAPTCHA →
needs_review rule.

Verified: `validate_local_config.sh` passes clean; `run_conformance.py
--harness all`; 15/15 pass, zero failures (the earlier session's one
flaky `harness:claude` failure did not recur, confirming it was
pre-existing test flakiness, not something either ATS addition broke);
fetch → canonicalize → fit-gate all exercised against real live data
end to end.

## 2026-08-10: BambooHR: spiked, then deferred (ToS blocks automated access)

Did the live-stability spike this doc already flagged as the
prerequisite before committing to BambooHR ("worth a live spike... not
as safe a bet as Workable"). The result is more nuanced than either
"ship" or "defer"; a genuine split finding, not a simple pass/fail:

**The list endpoint is real, stable, and public; better than
expected.** `https://<slug>.bamboohr.com/careers/list` returns clean,
compact JSON (`{"meta":{"totalCount":n},"result":[{id, jobOpeningName,
departmentLabel, employmentStatusLabel, location:{city,state}, ...}]}`)
with no auth header needed. Confirmed live against three real tenants
found the same never-guess-a-slug way as every other adapter (a search
for real live BambooHR-hosted job postings, not name-guessing): `crbr`
(4 real, current openings: Construction Technician, Business
Development Representative, Accounting Assistant, Reconstruction
Project Manager, all with real city/state), `zapier` and `asana` (both
resolve to real, valid tenants, confirming the endpoint shape
generalizes, but both currently show zero open postings, plausible
for two companies at any given moment, not a sign the endpoint is
broken). Stable across repeated requests (3 back-to-back calls all
returned identical data).

**The job DETAIL page, where the actual JD text lives, has no
deterministic access path at all. This is the blocker.** Unlike every
other list-without-JD source in this codebase (Oracle/Workday/
SmartRecruiters/JazzHR), which all have a real detail endpoint or
detail *page* reachable by a plain HTTP fetch, BambooHR's job detail
page (`<slug>.bamboohr.com/careers/<id>`) is a fully client-side-rendered
single-page app, confirmed live: a plain fetch returns ~95KB of pure
app-bootstrap HTML/JS (including, notably, the company's entire internal
product feature-flag list, hundreds of flags, leaking into the public
page, a strong independent signal this page was never meant to be
consumed outside a real browser), with zero server-rendered job content,
no `og:description`/meta fallback, and no discoverable unauthenticated
JSON detail variant (`/careers/<id>`, `/careers/list/<id>`,
`/careers/list?id=<id>` all either 404 or silently ignore the id and
return the full list again). The one *documented* detail API
(`{company}.bamboohr.com/api/v1/applicant_tracking/jobs[/id]`) is
confirmed gated; both endpoints 302-redirect without a token, exactly
as the original research found.

**Why this isn't a simple "ship the list, backfill JD later" call.**
`AGENTS.md`'s file-write discipline and every existing adapter's own
behavior agree on one rule: never fit-gate a job with empty `jd_text`.
Every other list-without-JD source in this codebase satisfies that with
a plain deterministic HTTP fetch for enrichment. BambooHR cannot; the
only way to recover real JD text here is either (a) a Playwright fetch
of the detail page per surviving candidate (a real architectural
precedent: no other Phase 16B adapter needs a browser for JD
enrichment, all are pure `urllib` HTTP), or (b) fit-gating on
title/department alone, a rule exception no other source gets. Neither
is a call this pass makes unilaterally; both are real, precedent-setting
decisions this project's own operating discipline treats as needing
explicit sign-off, not an autopilot pick.

**Resolved: deferred, not built; a third finding closed this out
before either option (a)/(b) above needed picking.** Checked
BambooHR's own Terms of Service (`bamboohr.com/terms-of-service`
§4.2) directly, prompted by the operator asking specifically whether
any path here was legal. It prohibits, verbatim: "use with any robot,
spider, other automated device, or manual process to monitor or copy
any content" from the Service, with **no carve-out for public career
pages and no search-engine/crawler exception anywhere in the
document**. This is the same category of finding as the Workday
ToS conflict documented elsewhere in this doc, a direct textual
prohibition, not inferred risk, and critically, it isn't scoped to
browser automation specifically: it covers a plain `urllib` fetch of
the `/careers/list` JSON endpoint just as much as a Playwright scrape
of the detail page. So it's broader than the (a)/(b) choice above; neither option, nor even shipping the LIST endpoint alone, clears it.
**Decision: BambooHR is deferred, full stop**, same conclusion and
same reasoning shape as Workday's auto-apply (as assessed 2026-08-10;
Workday's policy was later lifted in phase 7D, 2026-08-28; see
`docs/PLAN.md` §3.18B), not chosen between (a)
and (b), superseded by a straightforward "not legal to automate here"
finding.

**Not built:** no `fetch_bamboohr_listings.py`, no config keys, no
vetted-slugs file, no `job-scraper.md` step, live `targets.json`
untouched. BambooHR should not be revisited without a materially
different access path (e.g. a legitimate partner/API-key
relationship); not just a better scraper.

## 2026-08-10: iCIMS re-verified live (not just desk research): still deferred, worse than BambooHR

Operator asked to keep going on the remaining candidates after
BambooHR. iCIMS was the one worth a genuine hands-on re-check, highest
market share of the four still-deferred platforms (#1 enterprise ATS,
~25% of Fortune 500), and the earlier "partner-gated + CAPTCHA" verdict
came from an external research pass's desk research, not this
project's own live verification. Checked legality first this time,
before any technical poking, per the lesson from BambooHR:

**Legal: genuinely ambiguous, not a clean pass.** iCIMS's own
marketing-site Terms of Use (`icims.com/en-gb/legal/terms-of-use/`)
prohibits automated access ("any robot, spider or other automatic
device... to access the Website... including monitoring or copying any
of the material"), but its defined scope is explicitly `icims.com` and
its own subdomains/community site, not customer-hosted career sites
(which run on customer-specific hosts, e.g. `careers-ucla.icims.com`).
Unlike BambooHR (one vendor-wide ToS covering the exact hosted pattern
being fetched, no carve-out), there's no single document to check here; each customer's own site terms would govern their specific job board,
which isn't something this project can verify once per adapter the way
a single vendor ToS check works. Real ambiguity, not clearance.

**Technical: worse than BambooHR, not just unresolved.** Fetched a
real, live iCIMS-hosted career site directly (`careers-ucla.icims.com/jobs`,
confirmed real via UCLA's own HR department pages, not a guessed slug), confirmed live: **zero server-rendered job data of any kind**, not
even a partial win. The response is a ~530KB client-side app bundle
(every UI string template for the whole application flow: resume
upload prompts, email templates, error messages, baked into the page,
the same "internal app dumped into a public page" pattern BambooHR's
detail page had, but here it's the *listing* itself, not just the
detail view). No JSON-LD, no meta fallback, no server-rendered anchors
at all. BambooHR at least had a real, clean list endpoint; iCIMS has
nothing accessible without JS execution, meaning even the narrower
"ship listing only, defer JD enrichment" shape that worked for
Oracle/Workday/SmartRecruiters isn't available here either.

**Conclusion: defer, more clear-cut than BambooHR.** No accessible
data without a real browser, and the legal footing is uncertain rather
than clear either way. Not built: no adapter, no config keys, nothing
touched. **Jobvite, Rippling, and Breezy were not re-investigated this
pass**; their blockers (an opt-in-per-customer feed that's off by
default, an API gated behind the *employer's own* paid subscription,
no public API confirmed by the vendor's own developer docs) are
vendor-declared facts a live re-check can't change, unlike BambooHR/
iCIMS where "maybe there's an undocumented endpoint" was a genuinely
open, checkable question. Spending more research effort there isn't
warranted the way it was for these two.

**Phase 16B's ATS-matrix work has now reached a real, verified natural
pause**; every platform from the original competitor-derived matrix
is either shipped or deferred for a confirmed, specific reason
(structural gate, ToS conflict, or no accessible data at all), not an
open research question.

## Current status summary

### Shipped in Phase 16B so far

- SmartRecruiters
- Amazon
- Oracle Recruiting Cloud / Oracle tenant support
- Workable (2026-08-10)
- JazzHR (2026-08-10)

### Researched and explicitly not yet shipped

- Google
- **BambooHR: spiked 2026-08-10, deferred: ToS prohibits automated
  access.** The listing endpoint was real, stable, and public; the
  detail page (where JD text lives) had no deterministic access path,
  but neither mattered in the end: BambooHR's own ToS §4.2 prohibits
  "any robot, spider, other automated device... to monitor or copy any
  content," no public-content carve-out, same category of finding as
  the Workday ToS conflict elsewhere in this doc. Not revisitable
  without a materially different access path (e.g. a real partner/API
  relationship), not just a better scraper. See the dated entry above.
- Jobvite (opt-in customer-gated API; deferred, vendor-declared,
  not re-checked live)
- Rippling (real but paid-customer-gated API; deferred, vendor-declared,
  not re-checked live)
- **iCIMS: re-verified live 2026-08-10, deferred.** Largest market
  share of the group (#1 enterprise ATS), but a real, live-hosted
  career site (`careers-ucla.icims.com`) confirmed zero accessible job
  data without JS execution; worse than BambooHR (no working list
  endpoint even). Legal footing also genuinely ambiguous (iCIMS's own
  ToS scopes to icims.com itself, not customer-hosted career sites).
  See the dated entry above.
- Breezy / BreezyHR (confirmed no public API at all; deferred,
  vendor-declared, not re-checked live)
- Taleo / Oracle-legacy

### Strongest next additions

- Microsoft PCSX/Eightfold-style search
- more Oracle Recruiting Cloud tenants
- more Workday tenants

## Relationship to the roadmap

This document supports the current source-expansion work in `docs/PLAN.md`
Phase 16B / §3.18A.

It should be treated as the durable ATS/source reference for:

- what is already shipped
- what remains deferred
- what classes of sources exist
- what should be built next
