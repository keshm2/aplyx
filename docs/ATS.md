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

### Class 1 — Direct / public structured feeds

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

### Class 2 — Tenantized but still structured

Examples:

- Workday CXS
- Oracle Recruiting Cloud

Properties:

- strong value
- higher tenant-discovery burden
- often need JD enrichment/detail fetches

### Class 3 — Branded front-end / standard ATS back-end

Examples:

- Datadog -> Greenhouse
- Palantir -> Lever
- OpenAI -> Ashby

Best strategy:

- improve ATS board discovery rather than writing a new custom scraper for
  each branded page

### Class 4 — Branded HTML adapters

Examples:

- Apple
- Stripe

Properties:

- deterministic enough if the HTML is stable
- more maintenance than a public JSON/XML feed
- still much better than full browser automation if static HTML is enough

### Class 5 — Fragile internal app surfaces

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

## Current status summary

### Shipped in Phase 16B so far

- SmartRecruiters
- Amazon
- Oracle Recruiting Cloud / Oracle tenant support

### Researched and explicitly not yet shipped

- Google
- Workable
- BambooHR
- Jobvite
- Rippling
- iCIMS
- Taleo / Oracle-legacy

### Strongest next additions

- Microsoft PCSX/Eightfold-style search
- more Oracle Recruiting Cloud tenants
- more Workday tenants
- Apple HTML adapter
- Stripe HTML adapter

## Relationship to the roadmap

This document supports the current source-expansion work in `docs/PLAN.md`
Phase 16B / §3.18A.

It should be treated as the durable ATS/source reference for:

- what is already shipped
- what remains deferred
- what classes of sources exist
- what should be built next
