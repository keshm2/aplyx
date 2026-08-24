# Research — iCIMS automation for aplyx

## Summary
iCIMS is a legitimate ATS integration target, but the high-confidence path is an authorized customer/vendor/partner integration, not an unauthenticated public API: the Developer Community is for partner and customer developers, repeatable integrations go through partner validation, customer-specific integrations require a mutual customer, and the Job Portal/Search/Profiles/Workflows APIs all assume authenticated ICIMS access. — https://developer.icims.com/ ; https://developer-community.icims.com/getting-started/integrating-icims ; https://developer-community.icims.com/getting-started/partner-application-process ; https://developer-community.icims.com/applications/applicant-tracking/job-portal ; https://developer-community.icims.com/applications/applicant-tracking/search-api

The best near-term aplyx move is to keep iCIMS in “deferred / review-first” status, add only a robots-respecting public job-discovery research spike if product value justifies it, and do no automated application submission unless aplyx has explicit customer-authorized API credentials or a user-driven browser flow that stops before final submit. — file:///Users/keshmuthu/aplyx/AGENTS.md ; file:///Users/keshmuthu/aplyx/docs/ATS.md ; https://developer-community.icims.com/acceptable-use-policy ; https://developer-community.icims.com/terms-use

## Approaches / Subtopics

### iCIMS career-site structure and public posting surfaces
- iCIMS-hosted career sites commonly use tenant-style hosts such as `careers.icims.com`, `careers-customer0.icims.com`, `careers-ucla.icims.com`, and tenant-prefixed hosts like `ddc-dine-careers.icims.com`; observed robots policies vary from open crawl with `crawl-delay: 5` to full `Disallow: /`. — https://careers.icims.com/robots.txt ; https://careers-customer0.icims.com/robots.txt ; https://careers-ucla.icims.com/robots.txt ; https://ddc-dine-careers.icims.com/robots.txt
- The public iCIMS corporate careers tenant exposes a sitemap index that links to a job sitemap, and the job sitemap contains individual `/jobs/{id}?lang=...` posting URLs with fresh `lastmod` timestamps. — https://careers.icims.com/sitemap.xml ; https://careers.icims.com/sitemap1.xml
- The fetched public posting `https://careers.icims.com/jobs/6566?lang=en-us` contains a server-rendered Schema.org `JobPosting` JSON-LD block with fields such as `url`, `directApply`, `title`, `description`, `datePosted`, `validThrough`, `employmentType`, `hiringOrganization`, and `jobLocation`. — https://careers.icims.com/jobs/6566?lang=en-us
- The same posting page includes candidate tracking, analytics, OneTrust consent scripts, New Relic instrumentation, and Jibe/iCIMS client-side data objects, so treating it as a simple static page is unsafe beyond JSON-LD extraction. — https://careers.icims.com/jobs/6566?lang=en-us
- Some tenants may expose only sparse sitemap content: `ddc-dine-careers.icims.com` has a sitemap with only `/jobs/intro`, while its robots file allows normal jobs paths but disallows referral, login, candidate, reminder, and connect/resume/interest paths. — https://ddc-dine-careers.icims.com/sitemap.xml ; https://ddc-dine-careers.icims.com/robots.txt
- Evidence grade: **B** for public listing structure, because the JSON-LD and sitemap observations are primary fetches from live iCIMS-hosted sites, but tenant behavior is not uniform enough to generalize without a tenant-by-tenant probe. — https://careers.icims.com/robots.txt ; https://careers.icims.com/jobs/6566?lang=en-us ; https://ddc-dine-careers.icims.com/robots.txt

### Legitimate APIs, integrations, and gated posting feeds
- iCIMS positions its Developer Community as a self-service environment for partner and customer developers integrating applications and third-party vendor solutions with iCIMS ATS; new access currently requires emailing developer help with name, email, company, and user type. — https://developer.icims.com/
- iCIMS documents two integration paths: “Customer Specific” integrations and “ICIMS defined” integrations; the page explicitly says an integrator does not have to be an iCIMS partner to build an integration, but customer-specific work requires a mutual customer and is built on the customer platform rather than a shared sandbox. — https://developer-community.icims.com/getting-started/integrating-icims
- Repeatable integrations with multiple iCIMS ATS customer platforms are expected to follow the partner integration approval process, including design review, sandbox use for partner validation, and eventual marketplace validation or rejection. — https://developer-community.icims.com/getting-started/integrating-icims
- The partner application page says repeatable integration builders should apply to become an iCIMS Partner, while developers building on behalf of a customer should request Developer Community access and work through the customer’s iCIMS resource. — https://developer-community.icims.com/getting-started/partner-application-process
- The Job Portal API is documented as available for vendors and uses authenticated requests to `https://api.icims.com/customers/{customerId}/search/portals/{portalIdOrName}` to retrieve jobs posted to a portal. — https://developer-community.icims.com/applications/applicant-tracking/job-portal
- The Job Portal API returns portal URLs, self links, job IDs, and updated dates for portal search results, and job details are retrieved through the Profiles API. — https://developer-community.icims.com/applications/applicant-tracking/job-portal ; https://developer-community.icims.com/applications/applicant-tracking/profiles-api
- The Search API requires the API user to be in the Integration User group, returns system IDs rather than custom payloads, supports GET and POST, and is optimized for background synchronization rather than real-time portal use. — https://developer-community.icims.com/applications/applicant-tracking/search-api
- Search API paging is not cursor-token based: results are sorted by ascending System ID, capped at 1,000 per response, and subsequent pages require adding an ID filter greater than the last returned ID. — https://developer-community.icims.com/applications/applicant-tracking/search-api
- The Profiles API covers profile types including `people`, `jobs`, `companies`, `newhirecategories`, `talentpools`, `rooms`, and `connectevents`, and its permissions mirror what the authenticated user can access in the iCIMS Talent Platform. — https://developer-community.icims.com/applications/applicant-tracking/profiles-api
- The Workflows API exposes recruiting/applicant workflows as associations between job profiles and person profiles, with `applicantworkflows` as the Recruiting Workflow API identifier. — https://developer-community.icims.com/applications/applicant-tracking/workflows-api
- The Schema API returns JSON schema metadata for profile types, search results, search filters, iForms, and specific iForms; that makes it the right source for authorized field mapping instead of reverse-engineering forms from browser markup. — https://developer-community.icims.com/applications/applicant-tracking/schema-api
- iCIMS offers an optimized Standard XML Feed for approved third-party job boards, compiled from customer jobs and delivered three times daily beginning at 8am ET; vendors request onboarding and receive OAuth client credentials for test and production. — https://developer-community.icims.com/platform/services/standard-xml-feed-job-boards
- The XML feed contains job posting data such as reference ID, apply URL, title, description, date posted, job type, hiring organization, location fields, and extra fields, but customers can opt out of sending jobs to specific job boards globally or per career site. — https://developer-community.icims.com/platform/services/standard-xml-feed-job-boards
- Evidence grade: **A** for the existence and access model of official APIs/feeds, because these claims come from iCIMS developer documentation and policy pages. — https://developer.icims.com/ ; https://developer-community.icims.com/applications/applicant-tracking/job-portal ; https://developer-community.icims.com/platform/services/standard-xml-feed-job-boards

### Automation boundaries, anti-bot, CAPTCHA, and policy constraints
- The Developer Acceptable Use Policy permits retry logic when it uses exponential backoff, warns that integrations have API limits, and says excessive use or abuse may lead to loss of functionality, relationship termination, marketplace removal, or deactivation. — https://developer-community.icims.com/acceptable-use-policy
- The Developer Acceptable Use Policy says ICIMS endpoints cannot be accessed from mobile applications, developer workstations, or web browsers and must be addressed in marketplace solution design, which argues against putting API credentials in the aplyx desktop/extension client. — https://developer-community.icims.com/acceptable-use-policy
- The Developer Acceptable Use Policy prohibits bypassing ICIMS security or authentication measures, probing or exploiting ICIMS property, making bots or scripting exploits available, and using the Developer Site or Marketplace beyond expressly permitted uses. — https://developer-community.icims.com/acceptable-use-policy
- The Developer Terms of Use prohibit scraping, crawling, harvesting, indexing, mirroring, or using robots/bots/scripts/data-mining tools against the Developer Site except through documented and authorized API usage, and prohibit bypassing access controls, authentication mechanisms, rate limits, security controls, or usage restrictions. — https://developer-community.icims.com/terms-use
- The Developer Terms of Use require prior written approval before representing an integration as completed, certified, validated, approved, or operational, and they give iCIMS broad rights to review, reject, disable, suspend, remove, or require modification of integrations. — https://developer-community.icims.com/terms-use
- The Developer Terms of Use require minimum necessary Subscriber Data access, prohibit unauthorized data use, and impose privacy/security obligations for integrations processing Subscriber Data. — https://developer-community.icims.com/terms-use
- aplyx’s own project rules already require never bypassing CAPTCHA/rate limits, never auto-submitting Workday, never storing passwords outside the credential-safe design, and routing uncertain browser outcomes to `needs_review`. — file:///Users/keshmuthu/aplyx/AGENTS.md ; file:///Users/keshmuthu/aplyx/docs/ats-account-credentials-plan.md
- The shared browser runtime helper in aplyx detects CAPTCHA/challenge markers including reCAPTCHA, hCaptcha, generic challenge iframes, and Cloudflare challenge markers, and callers must abort on detection rather than clicking through. — file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py
- Evidence grade: **A** for developer-policy boundaries and aplyx internal safety rules; **C** for tenant-specific anti-bot behavior beyond directly fetched pages, because protected candidate/login flows vary by tenant and were not deeply crawled. — https://developer-community.icims.com/acceptable-use-policy ; https://developer-community.icims.com/terms-use ; file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py

### Browser timing strategy if a user-driven iCIMS browser flow is ever allowed
- aplyx already has a shared Playwright sync helper with bounded retries, stale-safe locator re-acquisition, CAPTCHA/challenge detection, page signatures, sanitized checkpoints, and a deliberate absence of any submit helper. — file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py
- The retry budget in the existing helper is three retry delays of approximately 500ms, 1.5s, and 4s with ±20% jitter, and it retries only `TransientActionError`, not arbitrary logic failures. — file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py
- The existing helper explicitly says final submit must remain a caller responsibility and must not be wrapped in automatic retry logic, which matches the product rule that irreversible application submission cannot be retried blindly. — file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py ; file:///Users/keshmuthu/aplyx/AGENTS.md
- A safe iCIMS browser flow should therefore be “fill/replay for user review” rather than “submit”: wait 300–900ms between non-final form interactions, use the existing 500ms/1.5s/4s retry schedule only for non-submit flaky controls, stop after 12–18 page advances, detect any repeated page signature, and route CAPTCHA/login/candidate-center ambiguity to `needs_review`. — file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py ; file:///Users/keshmuthu/aplyx/AGENTS.md

Pseudocode sketch, grounded in the existing runtime contracts: — file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py

```python
budget = StepBudget(max_steps=15)
seen_signatures = set()

for step in candidate_visible_steps(page):
    budget.consume()
    sig = page_signature(page, step.title)
    if sig in seen_signatures:
        return needs_review("repeated iCIMS page signature")
    seen_signatures.add(sig)

    challenge = detect_challenge(page)
    if challenge:
        return needs_review(f"captcha_or_bot_challenge: {challenge}")

    sleep(random.uniform(0.3, 0.9))
    for field in mapped_safe_fields(step):
        fill_or_select_exactly(field)
        verify_committed_value(field)

    click_with_retry(lambda: page.get_by_role("button", name=/next|continue/i))

# no helper for final submit; stop for user review or a single explicit user-approved click
return ready_for_user_review()
```

- Evidence grade: **B** for timing recommendations, because they are derived from aplyx’s existing reviewed runtime helper and policy constraints, not from iCIMS-published browser timing guidance. — file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py ; https://developer-community.icims.com/acceptable-use-policy

### Repo adapter comparison and implementation implications
- aplyx’s durable plan says iCIMS was deferred behind structural gates such as partner-only APIs and no public API path, while shipped or current sources include Greenhouse, Lever, Ashby, Workday review-only, SmartRecruiters, Workable, JazzHR, Amazon, Oracle, Eightfold, Apple, Google, Stripe, Gem, and The Muse. — file:///Users/keshmuthu/aplyx/AGENTS.md ; file:///Users/keshmuthu/aplyx/docs/ATS.md
- `atsRegistry.ts` currently defines the supported ATS family set as Greenhouse, Lever, Ashby, and Workday, so iCIMS is not a first-class apply/runtime family in the core registry. — file:///Users/keshmuthu/aplyx/src/core/src/atsRegistry.ts
- `jobsSort.ts` excludes iCIMS from the current `JobSource` union, so adding iCIMS listing ingestion would require source-schema changes before any runtime work. — file:///Users/keshmuthu/aplyx/src/core/src/jobsSort.ts
- The extension ATS selector module currently maps only existing supported families, so iCIMS public pages would need a separate detection/mapping decision before hybrid autofill could recognize them. — file:///Users/keshmuthu/aplyx/src/extension/src/ats.ts
- The account-credentials plan explicitly says account creation, application preparation, and final application submission are separate operations, and creating an account or uploading a resume must never silently submit an application. — file:///Users/keshmuthu/aplyx/docs/ats-account-credentials-plan.md
- A listing-only iCIMS adapter would resemble the project’s HTML-first adapters more than public JSON adapters, because public iCIMS career pages may expose sitemap/JSON-LD while the official Job Portal/Search/Profiles APIs require authorized API access. — https://careers.icims.com/sitemap1.xml ; https://careers.icims.com/jobs/6566?lang=en-us ; https://developer-community.icims.com/applications/applicant-tracking/job-portal
- An authorized iCIMS adapter would resemble Workday/Oracle in needing tenant identifiers and a strict review-only or API-authorized model, but would additionally need credential isolation because iCIMS APIs use customer IDs and authenticated integration users. — https://developer-community.icims.com/applications/applicant-tracking/search-api ; https://developer-community.icims.com/applications/applicant-tracking/profiles-api ; file:///Users/keshmuthu/aplyx/docs/ats-account-credentials-plan.md
- Evidence grade: **B** for repo implications, because the repository files are local primary evidence but no code search was run beyond the files named in the handoff. — file:///Users/keshmuthu/aplyx/AGENTS.md ; file:///Users/keshmuthu/aplyx/src/core/src/atsRegistry.ts ; file:///Users/keshmuthu/aplyx/src/core/src/jobsSort.ts

### Security and privacy model for any future iCIMS work
- API credentials should live only in a hosted server-side integration boundary, because iCIMS says credentials and endpoint access are integration-controlled and because the AUP says ICIMS endpoints cannot be accessed from developer workstations or web browsers. — https://developer-community.icims.com/acceptable-use-policy
- Candidate credentials should follow aplyx’s existing application-account model: metadata in owned rows, credential material in Vault, reveal only after explicit user action and recent re-auth, and no plaintext passwords, OTPs, cookies, or session tokens in logs/checkpoints/prompts. — file:///Users/keshmuthu/aplyx/docs/ats-account-credentials-plan.md ; file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py
- Subscriber/customer data from authorized iCIMS APIs should not be used to train, fine-tune, validate, or improve automated models unless iCIMS has expressly consented in writing, because the Developer Terms include a specific AI/ML data-use restriction for Subscriber Data. — https://developer-community.icims.com/terms-use
- A public-page listing adapter should store only job-posting data already exposed on allowed public pages, should honor `robots.txt` per tenant, and should not fetch login/candidate/referral paths where robots disallow them. — https://careers.icims.com/robots.txt ; https://ddc-dine-careers.icims.com/robots.txt ; https://careers-customer0.icims.com/robots.txt ; https://careers-ucla.icims.com/robots.txt
- Evidence grade: **A** for credential/privacy boundaries from policy and aplyx plan documents; **B** for public-page storage constraints because tenant-specific legal terms beyond robots may differ. — https://developer-community.icims.com/terms-use ; https://developer-community.icims.com/acceptable-use-policy ; file:///Users/keshmuthu/aplyx/docs/ats-account-credentials-plan.md

### Evidence grading rubric
- **A** means primary vendor documentation or local project source directly supports the claim. — https://developer.icims.com/ ; file:///Users/keshmuthu/aplyx/AGENTS.md
- **B** means direct observation from a small set of live tenant pages or an inference from primary documents supports the claim but tenant variation may change implementation details. — https://careers.icims.com/jobs/6566?lang=en-us ; https://ddc-dine-careers.icims.com/robots.txt
- **C** means the claim is plausible and useful for planning but needs a larger tenant sample, authenticated sandbox, or written iCIMS/customer authorization before implementation. — https://developer-community.icims.com/getting-started/integrating-icims ; https://developer-community.icims.com/getting-started/partner-application-process

## Conflicts
- Public career pages can expose job data through robots-allowed sitemaps and JSON-LD, while iCIMS Developer Terms prohibit automated scraping/crawling of the Developer Site except through authorized APIs. — https://careers.icims.com/robots.txt ; https://careers.icims.com/sitemap1.xml ; https://careers.icims.com/jobs/6566?lang=en-us ; https://developer-community.icims.com/terms-use. Resolution: treat these as different surfaces; a public career-site listing spike may be permissible only per tenant and only for robots-allowed public pages, while Developer Site/API use must remain documented and authorized.
- iCIMS says a developer does not have to be a partner to build an integration, but also says repeatable integrations across multiple customer platforms should follow the partner process. — https://developer-community.icims.com/getting-started/integrating-icims ; https://developer-community.icims.com/getting-started/partner-application-process. Resolution: customer-specific work can be non-partner with a mutual customer, but aplyx as a generalized product should assume partner/vendor approval for repeatable iCIMS API integration.
- The Job Portal API is described as “available for vendors,” but its examples require Basic Authorization and the Search API requires an Integration User group. — https://developer-community.icims.com/applications/applicant-tracking/job-portal ; https://developer-community.icims.com/applications/applicant-tracking/search-api. Resolution: “available” means available through an authorized vendor/customer integration, not public unauthenticated access.
- iCIMS provides a Standard XML Feed for job boards, but it is authenticated, vendor-onboarded, and customer opt-out capable. — https://developer-community.icims.com/platform/services/standard-xml-feed-job-boards. Resolution: this is the best legitimate broad job-ingestion route if aplyx becomes an approved job-board-style vendor, but it is not a fallback for immediate implementation.

## Gaps
- Exact iCIMS API rate limits for the specific endpoints aplyx would need are not confirmed from an accessible primary rate-limit page. — no reliable source found. To answer this, look for iCIMS “API Terms” or authenticated Developer Community docs for rate limits tied to the customer/vendor credential class. — https://developer-community.icims.com/acceptable-use-policy
- Candidate-apply form architecture across current iCIMS tenants is not reliably characterized from public pages alone. — no reliable source found. To answer this, test an authorized sandbox or a customer-approved tenant with Playwright traces that stop before submit and redact all PII/secrets. — https://developer-community.icims.com/getting-started/integrating-icims
- The precise legal boundary for scraping each customer-hosted iCIMS career site is tenant-specific and not answered by iCIMS Developer Site terms alone. — no reliable source found. To answer this, review each tenant’s posted terms/privacy pages and obtain customer or counsel approval before automated collection. — https://developer-community.icims.com/terms-use ; https://careers.icims.com/robots.txt
- hCaptcha/reCAPTCHA deployment details on current iCIMS candidate flows were not confirmed from a primary iCIMS release-note page in this pass. — no reliable source found. To answer this, use authenticated iCIMS Community release notes or live authorized tenant testing; do not infer bypass behavior from inaccessible snippets. — file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py
- The product ROI of an iCIMS public listing-only adapter is unknown because the number of target employers with robots-allowed, JSON-LD-rich iCIMS pages has not been sampled. — no reliable source found. To answer this, run a non-invasive discovery sample over a reviewed list of target companies using only robots/sitemap/head requests and record success/failure rates. — https://careers.icims.com/robots.txt ; https://careers-ucla.icims.com/robots.txt

## Recommendation
Do **not** build full iCIMS auto-apply now. Keep iCIMS deferred for automatic submission and permit only two future paths: (1) an authorized hosted integration using customer/vendor/partner credentials and iCIMS APIs/feeds, or (2) a user-driven hybrid browser/autofill flow that stops before submit and fails closed on CAPTCHA, login, repeated page signatures, unmapped fields, or robots/policy ambiguity. This rests on the official API access model, partner/customer integration requirements, authenticated Job Portal/Search/Profile/Workflow APIs, the gated XML job-board feed, iCIMS policy restrictions, and aplyx’s existing review-first safety model.

If product value warrants a small next step, build a **research-only listing probe**, not an application runtime: accept a tenant host, fetch `robots.txt`, fetch sitemap URLs only when allowed, extract JSON-LD `JobPosting` from public job pages, canonicalize into a temporary report, and produce a coverage score. Do not add `icims` to `AtsFamily`, `JobSource`, hosted worker sources, or extension apply mapping until that probe proves sufficient coverage and counsel/product explicitly approves the public-page interpretation.

Weakest assumption: the biggest assumption is that enough valuable iCIMS customer career sites expose robots-allowed sitemap/JSON-LD job postings to justify a listing-only adapter; if a broader tenant sample shows most target employers are `Disallow: /`, cookie-gated, login-gated, or missing structured job data, even the listing probe should be abandoned in favor of the authorized API/feed route only.

## Sources
1. https://developer.icims.com/ — iCIMS Developer Community home and access positioning for partner/customer developers.
2. https://developer-community.icims.com/getting-started/integrating-icims — official integration paths, partner vs customer-specific process, sandbox/validation context.
3. https://developer-community.icims.com/getting-started/partner-application-process — partner application and customer developer access guidance.
4. https://developer-community.icims.com/applications/applicant-tracking/job-portal — Job Portal API endpoints, authenticated examples, portal search/filter behavior.
5. https://developer-community.icims.com/applications/applicant-tracking/search-api — Search API requirements, Integration User group, paging, staleness, result shape.
6. https://developer-community.icims.com/applications/applicant-tracking/profiles-api — Profiles API profile types, permissions, person/job/company access patterns.
7. https://developer-community.icims.com/applications/applicant-tracking/schema-api — Schema API for profile/search/iForm schemas.
8. https://developer-community.icims.com/applications/applicant-tracking/workflows-api — Workflows API and recruiting/applicant workflow model.
9. https://developer-community.icims.com/platform/services/standard-xml-feed-job-boards — authenticated standard XML feed for approved job boards.
10. https://developer-community.icims.com/terms-use — Developer Site terms, restrictions, data/privacy/security obligations.
11. https://developer-community.icims.com/acceptable-use-policy — Developer AUP, retry/backoff, endpoint access, prohibited uses, credential handling.
12. https://careers.icims.com/robots.txt — public iCIMS careers robots policy with allow and crawl delay.
13. https://careers.icims.com/sitemap.xml — public iCIMS careers sitemap index.
14. https://careers.icims.com/sitemap1.xml — public iCIMS careers job sitemap with posting URLs.
15. https://careers.icims.com/jobs/6566?lang=en-us — example public iCIMS posting with JSON-LD JobPosting.
16. https://careers-customer0.icims.com/robots.txt — example tenant/candidate host with full disallow.
17. https://careers-ucla.icims.com/robots.txt — example customer tenant with full disallow.
18. https://ddc-dine-careers.icims.com/robots.txt — example customer tenant with selective disallows for login/candidate/referral/connect paths.
19. https://ddc-dine-careers.icims.com/sitemap.xml — example sparse tenant sitemap.
20. file:///Users/keshmuthu/aplyx/AGENTS.md — aplyx current ATS/source status and safety rules.
21. file:///Users/keshmuthu/aplyx/docs/ATS.md — aplyx existing ATS plan and prior iCIMS defer rationale.
22. file:///Users/keshmuthu/aplyx/docs/ats-account-credentials-plan.md — aplyx credential/account separation and no-silent-submit requirements.
23. file:///Users/keshmuthu/aplyx/src/scripts/runtime/browser_resilience.py — aplyx shared retry, challenge-detection, page-signature, and checkpoint-sanitization helper.
24. file:///Users/keshmuthu/aplyx/src/core/src/atsRegistry.ts — aplyx current first-class ATS family registry.
25. file:///Users/keshmuthu/aplyx/src/core/src/jobsSort.ts — aplyx current job-source union evidence.
26. file:///Users/keshmuthu/aplyx/src/extension/src/ats.ts — aplyx current extension ATS detection/mapping surface.
