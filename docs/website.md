# aplyx.app website

> **Status**: v1 built — all six pages live (`/`, `/features`, `/pricing`,
> `/install`, `/privacy`, `/changelog`), plain HTML/CSS/JS, self-hosted
> Inter throughout. Enabling GitHub Pages and wiring the `aplyx.app` DNS
> records at Name.com is a later, separate step — not done yet.

## Context

The operator owns `aplyx.app` (registered at Name.com) and wants people to
be able to type it into a browser and land on a real site. Nothing was
configured there before this — no DNS, no hosting, no site files. Beyond
just existing, the site should feel current — light and dark mode, smooth
transitions, in the spirit of Apple/Supabase/Vercel marketing sites — not
a bare, static-feeling page.

## Scope

Built the site files in this repo first. Enabling GitHub Pages and wiring
the `aplyx.app` DNS records is a later, separate step.

One clarification: GitHub Pages' default address for a project repo is
`keshm2.github.io/aplyx`, but only *before* a custom domain is attached —
once the `CNAME` file + DNS records are wired up later, the site is served
at `https://aplyx.app` directly and the `.github.io` URL redirects to it.

## Approach: plain static HTML/CSS + a little vanilla JS

No framework, no build step, no new npm workspace. `site/` contains plain
`.html` files, one shared `styles.css`, and one small `site.js` for theme
toggling + scroll-reveal. GitHub Pages will serve it directly once wired
up (deferred step).

Reused from the desktop app: Calm Cobalt colors
(`src/tauri/src/styles/tokens.css`'s bare `:root` block), the logo
(`src/tauri/src/components/Logo.tsx` / `logo-mark.png`), and the tagline/
subhead verbatim from `src/tauri/src/routes/EntryScreen.tsx`.

**Typeface**: Inter, self-hosted from the exact same variable-font file
the desktop app already bundles
(`src/tauri/src/assets/fonts/Inter-Variable.woff2`, copied to
`site/assets/fonts/`) — no CDN fetch, consistent with the project's
offline-first ethos. Used for both body copy and headings (`--font-body`
and `--font-display` both point to it); the previous serif display font
was dropped so headings and body read as one consistent modern sans,
matching the Apple/Vercel/Supabase reference points more directly than a
serif/sans pairing would.

Built out: home, features, pricing, install, privacy, and changelog — all
six pages sharing the same nav/footer/theme-toggle markup, `styles.css`,
and `site.js`. Adding another page later is still just another plain
file; nothing here needs re-architecting.

Top nav settled on **Features / Pricing / Install / GitHub** (dropped a
separate "Download" link once `/install` existed as a real destination —
the hero and pricing CTAs now point there instead of straight to GitHub's
releases page); **Privacy** and **Changelog** live in the footer only,
consistent with them being secondary/reference pages rather than primary
navigation.

## Design direction — researched, not guessed

Looked at how Apple/Supabase/Vercel-style sites actually achieve their
"smooth, current" feel, and how to get the same effect from plain
HTML/CSS/vanilla JS (no framework, no animation library).

### Light/dark mode: reuses the desktop app's own pattern

The exact mechanism already proven in `src/tauri/src/styles/tokens.css` +
`src/tauri/src/lib/uiPrefs.ts`:

- CSS custom properties on `:root`, overridden by `[data-theme="dark"]`;
  a `prefers-color-scheme: dark` media query supplies the default when no
  explicit choice has been made yet.
- A tiny **inline** `<script>` in `<head>` (before the stylesheet `<link>`)
  reads `localStorage` and sets `data-theme` on `<html>` synchronously —
  the standard fix for "flash of wrong theme," same reasoning
  `tokens.css`'s own header comment documents for the desktop app.
  Verified live: reloading with a stored dark preference shows no flash.
- A visible toggle (sun/moon icon, swapped via CSS) flips `data-theme` and
  persists it. Dark mode uses its own tuned palette (the desktop app's
  actual Calm Cobalt dark values), not an inverted light one — current
  guidance is explicit that a good dark mode is calibrated separately for
  contrast, and that images/screenshots that look fine on white can look
  harsh on dark and need a brightness/overlay adjustment
  ([NateBal, "Best Practices for Dark Mode in Web Design 2026"](https://natebal.com/best-practices-for-dark-mode/)) —
  relevant once `/features` gets real screenshots.
- **Smooth toggle transition**: wraps the swap in
  `document.startViewTransition(() => setTheme(...))` where supported —
  a soft cross-fade between palettes instead of an instant flip. Silently
  no-ops to a plain instant swap in unsupported browsers, so no fallback
  branch is needed
  ([MDN, View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)).

### Motion: scroll reveals + micro-interactions, not decoration

Current best-practice framing is explicit that animation should direct
attention, not decorate — scroll-triggered reveals and hover
micro-interactions add life without adding load time
([Striped Horse, "Best SaaS Website Designs in 2026"](https://www.stripedhorse.com/blog/best-saas-website-designs)).

- **Scroll reveal**: one `IntersectionObserver` (`site.js`) toggles an
  `.is-visible` class on `[data-reveal]` sections as they enter the
  viewport; CSS handles the fade + slight `translateY` transition.
  Respects `prefers-reduced-motion: reduce` — skips straight to visible,
  no animation. Verified live via Playwright.
- **Hover micro-interactions**: cards/buttons get a small lift
  (`transform: translateY(-2px/-3px)`) plus a border/shadow glow on hover,
  using a shared "snappy but smooth" easing curve —
  `cubic-bezier(0.16, 1, 0.3, 1)` (`--ease-out-expo` in `styles.css`), the
  same family of curve Vercel/Linear-style products use, distinct from the
  entrance-only `--ease-out` token (mirroring the separation of concerns
  `src/tauri/src/styles/motion.css` already keeps).
- **Sticky nav**: `position: sticky` with `backdrop-filter: blur(12px)`
  and a translucent background — the glassy header treatment common to
  Apple/Vercel/Supabase — gains a subtle border/shadow once scrolled past
  the top (`.site-nav.is-scrolled`, toggled by a scroll listener in
  `site.js`).
- Dark mode tones motion down slightly (shorter `--duration-normal`/
  `--duration-slow`, smaller `--reveal-rise` distance) per the research
  finding that fast motion reads as more jarring in low light than in a
  bright UI ([NateBal](https://natebal.com/best-practices-for-dark-mode/)).
- **Staggered reveal**: cards that enter the viewport together (a bento
  row, a pricing row) cascade in rather than snapping in all at once —
  each one's `is-visible` class is added on a short `setTimeout` offset
  (70ms × position within the batch) rather than via a CSS
  `transition-delay`. Deliberately not CSS-based: a lingering
  `transition-delay` on the element would also delay its *hover*
  transition afterward (delay and duration aren't scoped per-trigger in
  CSS), which would make cards feel laggy to interact with right after
  they'd revealed. Delaying *when the class is added* avoids that
  entirely.
- **Nav link underline**: a 1px underline wipes in from the left on hover
  (`::after` with `transform: scaleX`, not a plain instant show/hide) —
  the same understated wipe-in treatment as the reference sites' nav bars.
- **Smooth scroll**: `html { scroll-behavior: smooth }`, gated behind
  `@media (prefers-reduced-motion: no-preference)` so anchor jumps aren't
  forced for anyone who's opted out of motion.

### Page-to-page transitions: cross-document View Transitions

Since this is a multi-page static site (no SPA framework), `styles.css`
opts into cross-document View Transitions with one at-rule:

```css
@view-transition {
  navigation: auto;
}
```

On a same-origin navigation between two pages that both opt in, the
browser snapshots the old page, swaps in the new one, and cross-fades
automatically — no JavaScript involved. Support: Chrome/Chromium from
version 126, Safari from 18.5; browsers without support simply navigate
normally, so no fallback code is needed
([DebugBear, View Transition API guide](https://www.debugbear.com/blog/view-transitions-spa-without-framework);
[MDN, View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)).
Takes effect once a second page exists.

### Visual language

- Large, bold display headline ("Your job search, applied to.") with
  generous whitespace, not a dense hero.
- A soft, low-opacity radial gradient glow behind the hero using
  `--accent` — the understated version of the "gradient mesh" look common
  across this category of site.
- Feature section as a **bento-style grid** (`.bento` in `styles.css`) —
  one larger lead card plus three smaller supporting ones, collapsing to
  2 then 1 column on smaller viewports. 2026 design research calls out
  modular bento layouts as the current dominant SaaS pattern
  ([inspoAI, "50 Best SaaS Website Designs in 2026"](https://www.inspoai.io/blog/best-saas-website-designs-2026)) —
  scoped down here to a simple hover lift/border-glow per card, not
  autoplaying video-on-hover.
- Plain HTML/CSS/one small JS file throughout — the smooth feel comes
  from the specific techniques above (calibrated dark mode,
  reduced-motion-aware scroll reveals, native view transitions), not from
  a heavier framework or animation library.

## Page structure — all built

- `/` (`site/index.html`) — Logo, tagline, subhead, bento-style feature
  summary with a "See all features →" link, hero CTA to `/install`.
- `/features` (`site/features.html`) — six feature rows (multi-board
  search, deterministic fit gate, resume/cover-letter tailoring,
  review-before-send, TUI + desktop, optional Discord updates), each with
  an icon, expanding on the home page's bento summary. No product
  screenshots yet (none exist to embed) — text-only rows for now.
- `/pricing` (`site/pricing.html`) — three-tier pricing (Free / Pro /
  Business), reflecting the shape already designed in
  `docs/hosted-paid-tier-plan.md` (local free tier, hosted review-only,
  hosted auto-apply) but with **placeholder dollar amounts** ($0/$19/$49)
  and an explicit on-page note that pricing isn't final — no real Stripe
  plans exist yet.
- `/install` (`site/install.html`) — OS-tabbed instructions (macOS/Linux,
  Windows, npm), using the **real, verified commands from `README.md`**
  (not invented) — the curl/PowerShell one-liners and the npm global
  install. Tab switching is a small vanilla-JS click handler
  (`[data-os-tab]`/`[data-os-panel]` in `site.js`), no library.
- `/privacy` (`site/privacy.html`) — plain-language explanation of what's
  local-only vs. sent to a coding agent's model provider during tailoring,
  the opt-in Discord/Google Sheets flows, and an explicit "no aplyx-run
  server exists today" statement (true now; the hosted plan's own consent
  step is what would change this later).
- `/changelog` (`site/changelog.html`) — links out to GitHub's rendered
  `docs/CHANGELOG.md` rather than duplicating it, so it can't drift out of
  sync with real releases.

## Files

- `site/index.html`, `features.html`, `pricing.html`, `install.html`,
  `privacy.html`, `changelog.html` — the six pages
- `site/styles.css` — theme tokens (light/dark), layout, motion, pricing
  cards, feature rows, OS install tabs, prose/content-page styles
- `site/site.js` — theme toggle, staggered scroll reveal, sticky-nav
  scroll state, OS-tab switching
- `site/assets/logo-mark.png` — copied from `src/tauri/src/assets/logo-mark.png`
- `site/assets/fonts/Inter-Variable.woff2` — copied from
  `src/tauri/src/assets/fonts/Inter-Variable.woff2`

## Deferred: GitHub Pages + DNS (not done yet)

1. `site/CNAME` should contain: `aplyx.app`
2. Repo Settings → Pages → deploy from the `main` branch, folder `/site`.
3. In Name.com's existing DNS panel for `aplyx.app`, add four **A**
   records (`@`) pointing at GitHub Pages' IPs: `185.199.108.153`,
   `185.199.109.153`, `185.199.110.153`, `185.199.111.153`, and optionally
   a **CNAME** for `www` → `keshm2.github.io`.
4. In repo Settings → Pages, set the custom domain to `aplyx.app` and
   enable "Enforce HTTPS" once available.
5. No nameserver migration needed — GitHub Pages works with the DNS
   Name.com already manages.

## Verification done so far

- Toggled dark/light manually in a real browser (Playwright): no flash of
  the wrong theme on reload with a stored preference; dark mode uses the
  desktop app's own calibrated dark palette.
- Scrolled pages with `[data-reveal]` sections: correctly animate to
  visible via `IntersectionObserver` as they enter the viewport, staggered
  per card; confirmed via direct DOM inspection before/after scroll.
- Sticky nav's translucent blur and `is-scrolled` state confirmed visually
  while scrolled past the hero.
- Visual check across all six pages: colors/logo match the desktop app's
  own default (Calm Cobalt) theme in both light and dark mode; Inter
  renders correctly (confirmed via computed-style inspection, not just
  visually) for both body copy and headings.
- Navigated between pages via real link clicks (not programmatic
  redirects) — home → install via the hero CTA, home → pricing → back via
  the logo — confirmed zero console errors on every page, correct active
  nav-link underline on the current page.
- `/install`'s OS tabs: clicked each tab (macOS/Linux, Windows, npm) and
  confirmed the correct panel shows with a fade, others hide, and the
  commands shown are the real ones from `README.md` (not invented).
- `/pricing`: three tiers render with correct dummy amounts, the
  "Popular" badge and highlighted border on the middle tier, and the
  "illustrative pricing" disclaimer beneath the grid.
- All 6 pages return HTTP 200 from a local static server; no broken
  internal links (checked directly).

## Hero visuals: real desktop screenshot + a built TUI mockup

Two "device" panels sit behind the home page's headline, rotated for
depth, wrapped in a glass card (`backdrop-filter: blur(18px) saturate(140%)`
+ a translucent border/background — `.hero-mockup` in `styles.css`),
revealed with the same fade+rise+scale transition as everything else on
scroll. `.hero-content` sits at a higher z-index so the headline/CTAs
always stay crisp on top; `.hero-visuals` is hidden below 64rem so mobile
gets a clean text-only hero instead of cramped overlapping imagery.

- **Desktop app**: a **real screenshot** (`site/assets/screenshots/desktop-home.png`),
  not a mockup. Captured by running the actual Vite dev server and
  driving it with Playwright: `localStorage`'s `aplyx.localRoot` short-
  circuits `findRoot()` (bridge.ts already checks localStorage before
  ever calling into Tauri), and a small `window.__TAURI_INTERNALS__.invoke`
  stub answers `find_root`/`read_onboarding_completed`/`load_local_state`
  with plausible sample data — enough to reach the real `HomeScreen`
  dashboard render without a native Tauri runtime. Forced
  `aplyx.theme=dark` + `aplyx.themeFamily=cobalt` explicitly, since the
  browser's leftover/default state didn't necessarily match the site's
  own Calm Cobalt accent otherwise.
- **TUI**: **not a screenshot** — there's no straightforward way to
  capture an Ink terminal render through the tools available here, so
  this is a small hand-built HTML/CSS terminal window (`.term*` classes)
  instead. It's built from the TUI's real identity, not invented: the
  violet accent is `src/tui/src/theme.ts`'s actual "Aplyx Default" palette
  (`#8B5CF6`), the tab names (Status/Jobs/Review/Letters/History/Resumes/
  Config) are `src/tui/src/ui/App.tsx`'s real `TAB_LABEL` values, and the
  `[x]`/`[ ] Company — Title` row style mirrors `SearchScreen.tsx`'s
  actual list rendering. Documented here as a stylized likeness, not a
  literal capture, in the same interest of accuracy as the privacy page.

## Fix: hero mockups overflowing at common window widths

The first version anchored the two hero mockups' offsets to the raw
viewport (`vw` units) and bled them fairly far past the hero's edges —
looked fine at the one width tested, but at other common widths this
caused two real problems, both fixed:

- **Horizontal overflow/collision.** `.hero-visuals` is now constrained
  to the same centered, max-72rem column as `.wrap`, not the full
  viewport — the mockup offsets are anchored to the readable content
  column, so they stay proportionate at both narrow and very wide
  windows instead of stretching unpredictably with `vw`. The "hide below
  this width" breakpoint moved from 64rem to 72rem so they only ever show
  where there's genuinely comfortable room.
- **The mockups overlapping the H1 itself.** The real bug behind "goes
  off screen a little": both mockups' `top` offset was small enough that
  their chrome bar/tab row sat directly under the H1's own two text
  lines — since `.hero-content` is a higher z-index, the opaque headline
  text visually bisected the card's top edge, which read as a rendering
  glitch (a tab row appearing to float outside its own frame) rather
  than an intentional "peeking from behind" look. Fixed by pushing both
  mockups down (`top: 12.5rem` / `15rem`) to clear the H1's height
  entirely — they now only ever overlap the lighter subhead text below
  it. Confirmed via an element-scoped screenshot that isolated exactly
  what was overlapping what before landing on this explanation.
- Also added `overflow: hidden` directly on `.term-tabs` itself (not just
  relying on the ancestor card's own `overflow: hidden` + backdrop-filter
  combination, which isn't reliably clipping in every browser) as a
  second, independent safety net.

Verified at 1160px (just above the new breakpoint), 1280px, 1400px, and
1920px — no horizontal page overflow, no text collision, mockups stay
anchored near the content column rather than the raw viewport edges at
every width checked.

## Small "peek" accents on other app/TUI-relevant sections

Beyond the home page hero, two more spots that specifically talk about
the desktop app/TUI now show a small glass-card thumbnail (reusing the
same real desktop screenshot, cropped via `object-fit: cover` to a
zoomed-in corner of it) with the same fade/rise/rotate reveal as
everything else, timed to settle in just after its parent's own reveal:

- Home page's **"TUI + desktop" bento card** — `.mini-peek`, absolutely
  positioned top-right (safe because that card anchors its text to the
  bottom via `justify-content: flex-end`, leaving the top empty).
- `/features`' **"TUI and desktop, same core" row** — `.feature-row-peek`,
  a normal in-flow flex sibling (`margin-left: auto`) rather than
  absolutely positioned, since that row's icon+text fills the row
  edge-to-edge and an absolutely-positioned corner accent would risk
  overlapping the text on some widths. Both hide below 30rem, where
  there's no comfortable space left for either.

## Text-over-image legibility fix

Pushing the hero mockups down (above) cleared the H1 but created a new
problem: the subhead's `--text-muted` gray has real contrast against
`var(--ground)`, but not against a bright screenshot glimpsed through
45%-opacity glass behind it — reported live as "the text isn't visible
anymore." Fixed with a soft, feathered scrim: `.hero-content::before`, a
radial gradient in `var(--ground)` positioned behind just the text
column, fading to transparent via its outer gradient stop rather than a
hard-edged panel. This keeps text legible in the one place it needs to
be, while leaving the mockups fully visible everywhere the scrim doesn't
reach — including their inner edges peeking in beside the headline.

## More eye-catching scroll reveals (site-wide)

`[data-reveal]` now does blur-to-focus + a slight scale in addition to
the existing fade/rise — elements arrive slightly blurred and scaled to
97%, then sharpen to full focus as they settle in. Applied consistently
everywhere reveal styling exists (the hero mockups' own override rules,
`.mini-peek`/`.feature-row-peek`'s parent-triggered reveals), not just
the generic rule — each of those defines its own `transition` list, so
`filter` had to be added to each explicitly or it would've silently not
transitioned even though the generic rule's blur values still applied to
those elements structurally. Still respects `prefers-reduced-motion`
through the same existing global override.

## New home page sections (stats, how it works, FAQ, final CTA)

The page felt short, so it's substantially longer now — four new
sections between the hero and the footer:

- **Stats row** (`.stats`, under the "Everything the job hunt shouldn't
  take from you" heading): four callouts — "6+ boards searched in one
  pass," "0 times you copy-paste your resume," "100% of applications
  stay reviewable," "1 profile that tailors itself." Deliberately **not**
  a time-saved claim — there's no real usage data to back a number like
  that yet, and an invented one would read as marketing fluff at odds
  with the rest of this site's fact-checked tone (the pricing page's own
  "illustrative, not final" disclaimer, the privacy page's "no server
  exists yet" honesty). These four are structural facts about how the
  product actually works, framed as stats — professional, and true,
  without needing to fabricate a metric.
- **"How it actually works"** (`.how`/`.steps`): the real four-stage
  pipeline (Search → Fit-check → Tailor → Review & apply), each step's
  copy matching what `/features` and `AGENTS.md` already describe, not
  new claims.
- **FAQ** (`.faq`): four questions pulled from what's already documented
  elsewhere on the site (coding-agent requirement from `/install`, data
  handling from `/privacy`, platforms from the README) rather than
  invented — this page just surfaces them as direct answers.
- **Final CTA banner** (`.cta-banner`): a closing "Stop doing this one
  tab at a time" card before the footer, matching the site's existing
  button styles.

## Pricing update: $13/$33, generous daily auto-apply quotas

Pro dropped $19 → $13, Business $49 → $33, and both tiers are now
differentiated mainly by a daily auto-apply allowance (Free 3/day, Pro
10/day, Business 25/day, unlimited manual on every tier) rather than by
withholding features outright. These numbers aren't arbitrary — see
`docs/hosted-paid-tier-plan.md`'s new "Concrete tiers + quota capacity
analysis" section for the actual reasoning against Supabase's and
Fly.io's real current free-tier limits (checked live, not assumed): the
real constraint turned out to be Anthropic API cost and Playwright
browser-automation concurrency, not storage, which the original "will
this overload something" question was really asking about.

### Added: Intern tier, $9/month

A fourth tier sits between Free and Pro: **Intern**, scoped to
internship & new-grad postings only, priced at $9/month (revised down
from an initial $9.99 on request). Matches Pro's daily auto-apply quota
(10/day) exactly — "the tier above it" — rather than a smaller number,
since the differentiator here is *scope* (internships only) not volume.
Everything else about it (unlimited manual search/review, hosted
tailoring, email support) mirrors Pro's feature depth; it deliberately
doesn't chain off "Everything in Free" the way Pro/Business do, since
it's a parallel, narrower-scope offering rather than a strict superset.

Doesn't change the capacity analysis above in any way that matters: an
Intern subscriber's worst-case daily demand (10 auto-applies) is
identical to a Pro subscriber's, already accounted for. The only real
effect is on revenue mix (a user might pick the cheaper Intern tier over
Pro for the same daily volume, if internship-only scope is all they
need) — a pricing/product question, not an infra one.

`.pricing-grid` moved from 3 to 4 columns, with a new intermediate
2-column breakpoint at 72rem before collapsing to 1 column at 32rem
(the bento/steps sections' own 2-then-1 pattern) — four cards with a
full feature list each got cramped jumping straight from 4 columns to 1
the way three cards previously did.

## Blue content links + session-scoped visited state

Genuine inline prose links (`a.link` — the `opencode`/`Claude Code`
mentions on `/install`, the "Privacy page" mention in the home page FAQ)
now render in the accent blue with an underline, and switch to a muted
gray once clicked. Deliberately scoped to just those — the top nav and
footer links keep their existing muted/underline-on-hover treatment
unchanged, since their position already makes them obviously navigation;
recoloring those too would've added visual noise to chrome that wasn't
the actual problem.

"Visited" is tracked in `sessionStorage` (`site.js`), not a real CSS
`:visited` — matches "visited in this session" literally (clears when the
tab/session ends, unlike permanent browsing history), and sidesteps the
real privacy restrictions modern browsers already place on `:visited`
styling (color-only, and some browsers partition it per top-level site
in ways that would've made a permanent version unreliable for this
anyway). Verified live: clicking a link records its href, and a reload
of the same tab shows it in the muted "visited" color while an unclicked
sibling link stays blue.

## Company marquee — real logos, self-hosted, honestly captioned

An auto-scrolling strip sits right below the hero on the home page. Now
uses **real company logos**, on operator request (an earlier pass used
plain text wordmarks over endorsement-implication concerns — overridden
here, with the honest caption kept in place as the actual mitigation for
that concern, since it's the caption's wording, not the presence of a
logo mark itself, that determines whether this reads as a partnership
claim).

**Source: [Simple Icons](https://simpleicons.org/), CC0-licensed** — an
open-source library of brand icon SVGs explicitly released for free
reuse, verified live (`LICENSE.md` in their repo) rather than assumed.
CC0 covers the icon artwork's copyright; it doesn't waive the underlying
brand's trademark, so the honest, non-partnership caption stays doing
real work here regardless of the switch from text to logos.

Downloaded once into `site/assets/logos/` (self-hosted, no runtime CDN
call, consistent with the site's existing font-hosting approach) —
`zoom`, `discord`, `spotify`, `notion`, `figma`, `stripe`, `datadog`,
`duolingo`, plus four swapped in: **Ramp, Plaid, Microsoft, and Amazon
have no entry in Simple Icons at all** (confirmed by grepping the
library's own slug list — zero matches for any of the four), so
`brex`, `coinbase`, `netflix`, and `airbnb` fill the same "mix of
big-name and mid-size" role instead, rather than reaching for a
different, less-clearly-licensed source just for those four.

### Follow-up fixes: size, chip color, and the loop breaking

Three things came back wrong after the first pass, all fixed together:

- **Icons too small/unrecognizable** — bumped rendered size from 1.5rem
  to 2.25rem, with more chip padding to match (`.marquee-item`).
- **Stark white chips looked jarring in dark mode** — switched to one
  soft muted gray (`#e9ebf0`) plus a subtle border in *both* themes,
  rather than pure `#ffffff`. Still theme-independent on purpose: the
  chip's whole job is guaranteeing contrast for near-black logos
  (Notion, Brex) regardless of which theme is active, so it can't just
  get dark in dark mode without breaking that — softening the color
  (not darkening it) was the fix, not making it theme-reactive.
- **The loop breaking — sometimes visibly running out of logos before
  abruptly snapping back.** Root cause: the `<img>` tags had no explicit
  `width`/`height` and used `loading="lazy"`, so each image's rendered
  width was unknown until it actually loaded — and since the two
  duplicated `.marquee-group`s could finish loading their (identical)
  images at slightly different times, they could end up at genuinely
  different pixel widths for a while. The seamless-loop trick
  (`translateX(-50%)`) only works if both groups are *exactly* equal
  width; any mismatch shows up exactly as described — content runs out
  on one side before the wraparound point, then jumps. Fixed by adding
  explicit `width="24" height="24"` to every marquee `<img>` (all twelve
  Simple Icons SVGs use a 24×24 viewBox, confirmed by checking each
  file) and dropping `loading="lazy"` (this is above-the-fold content
  anyway — deferring it was never buying anything). Verified live: both
  groups now measure identically (1512px each in a 1400px-viewport
  check) immediately at load and a full second later — no async
  layout shift possible anymore, so the `-50%` math is exact every time.

### Follow-up #2: dark chips in both modes, dimmed further in dark mode

The muted-gray-in-both-themes chip (above) was itself superseded on
request: **light mode's chip is now literally the dark theme's own
`--surface-raised` tone** (`#1c2438`) — a deliberate dark plate popping
against the light page, not an accident. **Dark mode's chip is a
dimmer value than that same tone** (`#10141d`), not reused as-is —
reusing the light-mode chip's brightness in dark mode was exactly the
"blinding in a dark room" complaint, so it's tuned dimmer specifically
for that context via the same `[data-theme="dark"]` /
`prefers-color-scheme` override pattern used everywhere else on this
site.

Making the chip dark in *both* modes reopened the exact problem the
white/gray chip existed to solve: Notion (`#000`) and Brex (`#212121`)
are near-black, so they'd vanish against a dark chip. Fixed with a
targeted `filter: invert(1)` on just those two `<img>` tags
(`.marquee-logo-invert`) — flips near-black to near-white, which reads
fine on the dark plate. Every other logo here already uses a genuinely
saturated brand color with real contrast on dark, so nothing else needed
touching. Verified live in both themes via computed-style inspection
(`filter: invert(1)` confirmed applied) and visually — both logos are
legible, and the chip itself now blends much closer to the page in dark
mode instead of glowing.

### Follow-up #3: dark mode's chip overcorrected — too dark to read clearly

`#10141d` (Follow-up #2's dark-mode value) turned out too close to the
page's own near-black background — a chip that dim doesn't read as a
distinct box at all, just a slightly-different-shade smudge. Dark mode's
chip is now **light instead of dark** (`#e2e4ea` — noticeably dimmer
than pure `#fff`, but unambiguously a light, clearly-bounded plate
again), while light mode's chip stays exactly as Follow-up #2 left it
(the dark `#1c2438` plate). Only dark mode's value changed.

That flip reverses which logos need `.marquee-logo-invert`: with dark
mode's chip now light, Notion's and Brex's native near-black already has
real contrast there — inverting them too would wash them out to
near-white on an already-light chip. The invert filter is now switched
back to `filter: none` specifically in dark mode (same
`[data-theme="dark"]` / `prefers-color-scheme` override pattern as the
chip color itself), while staying `invert(1)` in light mode where the
chip is still dark and they'd otherwise vanish. Verified live: light
mode keeps `filter: invert(1)` on Notion; dark mode now computes
`filter: none` on the same element, and both read clearly in their
respective screenshots.

Built as two identical, duplicated groups inside one flex track
animated via `translateX(0) → translateX(-50%)` — the standard seamless-
loop technique, since the second (identical) group lands exactly where
the first started. Pauses on hover and respects `prefers-reduced-motion`
(animation removed entirely, not just slowed).

## Stat count-up on scroll

The home page's stats row (`6+`, `0`, `100%`, `1`) now counts up from 0
the first time it scrolls into view, via a small `requestAnimationFrame`
loop with an ease-out-cubic curve (`site.js`'s `animateCountUp`) — parses
the leading digits, keeps whatever suffix follows (`+`, `%`) fixed for
the animation, and skips entirely for a target of 0 (nothing to count up
to). Triggered once per page load via the same `IntersectionObserver`
pattern already used for scroll-reveal, and skipped entirely under
`prefers-reduced-motion` (the static target values already in the markup
are the correct reduced-motion result — nothing needs to run to "finish"
them).

Verified the easing math by hand and confirmed the final values land
exactly on target; verifying the *visible* slow-motion ramp itself
wasn't reliable through headless-browser automation here — headless
Chromium doesn't throttle `requestAnimationFrame` to a real display
refresh rate the way an actual visible tab does, so the animation
completes near-instantly under automation regardless of the real
900ms duration set in code. This is a well-established, standard
technique (not novel/risky), so this is noted as a testing-methodology
limitation, not an unresolved correctness question.

## New feature row: inbox-derived status tracking (planned, not built)

`/features` gained a 7th row describing a real, substantial new product
feature the operator wants designed: once an application goes out,
aplyx watches the inbox on the user's profile and automatically updates
that job's status (Applied, OA Sent, Interview Requested, Offer,
Rejected) as responses arrive. **Not built yet** — flagged with a
visible `.feature-badge` "Planned" pill next to the heading, same
honesty convention as the pricing page's "illustrative, not final" note
and the privacy page's "no server exists today" line. The full design
(data model, email matching/classification, the terminal-state guard,
privacy/security constraints, TUI + desktop UI plan, phased rollout) was
grounded in the actual existing code (the real `STATUS_BADGE`/
`statusGlyph` conventions already in `HomeScreen.tsx`/`HistoryScreen.tsx`/
`theme.ts`, the real `AppliedJob` schema, the real Discord opt-in
pattern), not invented from scratch. **Update: this feature has since
shipped (hosted-only, 2026-08-19 → 2026-08-21)** — see `AGENTS.md`'s
"Inbox status detection" section for the current design. This site copy's
"Planned" framing is stale and worth reconciling with the marketing pages
directly, not just this doc.

Two new semantic color roles (`--info` blue, `--special` violet) were
added to this site's own `:root`/dark/light blocks in `styles.css` —
same hex values proposed for the real app's `tokens.css` in the plan
doc, so this demo previews the actual intended design rather than a
one-off marketing mockup. `good`/`danger` were also added here for the
first time (this site never needed status colors before) using the
exact same values as `src/tauri/src/styles/tokens.css`'s Calm Cobalt
light/dark palette.

### Mouse-following glow demo

The row includes a live interactive preview: a soft radial-gradient
glow (`.status-demo-glow`) trails the cursor across the five status
pills. Implementation is deliberately thin — `site.js`'s `mousemove`
handler only ever sets the glow's target `transform`; all of the actual
"smoothness" comes from a plain CSS `transition` on that property
(550ms, `--ease-out`), the same technique already used for the theme
toggle's cross-fade. No animation loop, no per-frame JS. Hidden below
40rem width (`prefers-reduced-motion` isn't quite the right guard here —
a hover-following glow has nothing to do on a touch device that can't
hover at all, so it's a width-based cut instead). Verified live: the
glow's inline `transform` updates synchronously on `mousemove` (checked
directly, not just the animated computed value mid-transition), and it
resets off-screen on `mouseleave`.

## Mobile nav: hamburger menu (fixes the ~400px overlap)

The nav's four links (Features/Pricing/Install/GitHub) plus the theme
toggle now collapse into a hamburger below `max-width: 46rem` (`.nav-toggle`
in `styles.css`), instead of colliding with the logo wordmark. The links
themselves moved into a new `.nav-links` wrapper (`data-nav-links` in the
markup, identical across all six pages) so CSS can target just them without
touching the theme toggle.

- **Hamburger → X**: three `.nav-toggle-bar` spans, rotated/faded via a
  `.is-open` class — same "snappy" `--ease-out-expo` easing as the rest of
  the nav's micro-interactions, not a plain icon swap.
- **Dropdown panel**: `.nav-links` is clipped to `max-height: 0` when
  closed and expands on `.is-open`, rather than `display: none` — gives
  the open/close something to actually transition, consistent with how
  scroll-reveal avoids instant show/hide elsewhere on this site. Respects
  `prefers-reduced-motion` (transition removed, not just shortened).
- **`site.js`** wires the toggle plus three ways to close it: clicking a
  link (so it doesn't linger open behind a navigation), clicking outside
  the nav, and Escape — the same "closeNavMenu" path handles all three.
- **Caught and fixed during verification**: the first pass gave
  `.nav-links` `flex-direction: column` only inside the mobile media
  query, with no base `display: flex` — so instead of stacking, the links
  rendered as a horizontal row that just wrapped. Added `display: flex` to
  the base (non-mobile) `.nav-links` rule, which both fixed the mobile
  stack and correctly keeps the desktop nav's links laid out inline as
  before.
- Verified live via Playwright at 400px (previously-broken width — logo
  and hamburger no longer collide), 730px (hamburger, just below the
  breakpoint), and 760px (full inline nav, just above it) — clean
  transition, no in-between overlap. Checked open/closed states in both
  light and dark mode, and confirmed the active-page link (e.g. "Pricing"
  on `/pricing`) still bolds correctly inside the dropdown. Click-outside
  and the pricing page's 4-column grid collapsing to 1 column at the same
  width were both confirmed working together, not just each in isolation.

## Real product screenshots for `/features`

Three of the seven rows now show a real desktop-app screenshot instead of
staying text-only, using the same technique as the home page hero (Vite
dev server + Playwright + a `window.__TAURI_INTERNALS__.invoke` stub —
this time driving the actual `/app/jobs`, `/app/review`, and
`/app/resumes` routes directly via URL hash rather than just `/app`):

- **Multi-board search** → the Jobs screen, mid-search: source badges
  (Ashby/Lever/Greenhouse/SmartRecruiters/Workday, with per-source counts),
  seven fictional-company results, and the selected posting's detail pane
  showing a real fit-gate score + reasoning — one screenshot covers both
  this row and "A deterministic fit gate" immediately below it, so that
  row deliberately stays text-only rather than repeating the same image.
- **Resume & cover letter tailoring** → the Resumes screen, listing the
  six base-resume categories (SWE/AI-ML/Cyber/Networking-Cyber/Balanced/
  cover letter) with their conversion status.
- **Review before it goes out** → the Review queue screen: three pending
  entries with ATS scores, and the selected entry's resume/URL/reasoning
  alongside Open/Mark applied/Dismiss.

New `.feature-shot` component in `styles.css` — the same window-chrome
treatment (colored dots) as the home page's floating hero mockups, but
static/in-flow rather than absolutely positioned, with its own
scroll-reveal (blur/rise/scale, same as everything else). Company/job data
in the stub is entirely fictional (`Northwind Systems`, `Fernbank Health`,
etc., with plausible-looking-but-fake `boards.greenhouse.io`/`jobs.lever.co`
URLs) — deliberately not real companies, so nothing here reads as a
fabricated real job posting from an actual employer, a different concern
than the honestly-captioned real-logo marquee elsewhere on the site.

**Two real things caught during capture, both fixed before finalizing:**
1. Hash-only navigations (`page.goto()` between `#/app/jobs` and
   `#/app/review`) don't trigger a real document reload, so an updated
   `addInitScript` silently never re-ran between captures — the fix was
   forcing a real navigation (`goto('about:blank')` then back) before each
   round of captures that depended on updated stub data.
2. First pass reused `example.invalid`-style placeholder URLs for the fake
   postings — technically fine (IANA-reserved for exactly this use) but
   read as an obvious placeholder in a screenshot meant for the public
   site. Swapped to realistic-looking fake ATS URL patterns
   (`boards.greenhouse.io/<fake-company>/jobs/<id>`, etc.) matching each
   source's real URL shape.

Verified live: all three screenshots render correctly in both light and
dark mode (the screenshots themselves are always dark — the desktop app
was captured with `aplyx.theme=dark` forced, same as the home page hero —
which reads fine as a product shot sitting in a light-mode card), the
`feature-shot` scroll-reveal triggers correctly, and at a 400px mobile
width the images shrink in place rather than break layout (smaller and
less legible at that width, but consistent with how the existing
`feature-row-peek`/`mini-peek` thumbnails already handle narrow viewports
elsewhere on this site — not a new tradeoff introduced here).

## Pricing page restructure: local-first showcase, renamed top tier

`/pricing` no longer opens straight into a 4-card grid with Free as one of
the cards. New structure, top to bottom:

1. **Hero** — rewritten to lead with local ("Free forever, running
   locally"), not a generic "simple pricing" line.
2. **Local features showcase** (`.local-section`/`.local-grid`) — a
   10-item grid (2 columns, same icon+title+description shape as
   `/features`' rows, scaled down) covering every free/local capability:
   every core feature (linking to `/features`), quick setup, preferred
   locations/companies, the TUI, the desktop app as a hub, unlimited
   auto-applications (bounded by the user's own coding agent, not by
   aplyx), resume review + fit-gate ranking, manual search across
   Ashby/Lever/Greenhouse/Workday/SmartRecruiters, data never leaving the
   machine, and one resume profile. Ends with its own "Get started, free"
   CTA.
3. **"Prefer not to run out of usage limits?" hook** (`.usage-hook`, new
   component reusing the home page's `.cta-banner` card treatment) — the
   bridge into the hosted plans: local is bounded by the user's own coding
   agent's usage caps and needs the device on/online; hosted removes both
   constraints. Placed deliberately between the free showcase and the paid
   grid, not folded into either.
4. **Paid plans grid** — now 3 cards, not 4 (`.pricing-grid` moved from
   `repeat(4, 1fr)` to `repeat(3, 1fr)`, and the old 4-card 2-column
   tablet breakpoint at 72rem was replaced with a single 64rem breakpoint
   straight to 1 column — 3 cards don't split evenly into 2 without an
   orphan card on its own row the way 4 did). **Business renamed to
   Premier** ("for all"); Intern and Pro keep their names but get new
   taglines pulled from the operator's own wording (Intern: "for undergrads
   eager to start their career, or applying late — no matter where you are
   in your timeline"; Pro: "for undergrads and new-grads who feel the
   pressure to land something").

Each paid card also picked up: an explicit "same TUI/desktop app, same
setup" callout (so hosted doesn't read as a downgrade on those fronts),
"profile & resumes stored securely in our Supabase-backed database," and
an "automatic job status tracking from your account email" line — tagged
with the same `.feature-badge` "Planned" pill `/features` already uses for
this exact capability (at the time this was written, it was the same
not-yet-built feature described in the now-removed
`docs/application-status-tracking-plan.md`; it has since shipped — see
`AGENTS.md`'s "Inbox status detection" section — so both "Planned" pills
are stale and should be reconciled with the live marketing copy).

### Three things worth the operator's attention, not resolved silently

- **Cover-letter tailoring now reads as paid-only** in the new copy
  (present in the Intern/Pro/Premier cards, absent from the local
  showcase's own list) — but `/features` already documents "Resume &
  cover letter tailoring" as a base, non-gated capability everyone gets
  today. These two pages now say different things about the same
  feature. Left as-is pending a decision on which is actually intended
  (gate it locally too, or restore it to the local showcase) rather than
  silently picking one.
- **Paid-tier auto-apply is *not* worded as literally unlimited**, despite
  that being requested. Kept the existing numeric daily caps (10/10/25)
  reworded as "without hitting your own agent's limits," because a
  literal "unlimited" directly contradicts `docs/hosted-paid-tier-plan.md`'s
  own "Concrete tiers + quota capacity analysis" section — that analysis
  exists specifically because Anthropic API cost and Playwright
  browser-automation concurrency are real, bounded constraints on a
  hosted worker, not just an arbitrary number. Genuinely unlimited hosted
  auto-apply would need that capacity analysis reworked first, not just a
  copy change.
- **Free tier's meaning shifted**: it now reads as "unlimited, bounded by
  your own coding agent" with zero hosted component at all, rather than
  the old "3 auto-applications per day" *hosted* free tier the capacity
  analysis in `docs/hosted-paid-tier-plan.md` was originally built around.
  That doc's quota reasoning (3/10/25) assumed a free tier drawing on
  hosted worker capacity; this page no longer has one. Worth reconciling
  that doc if this framing sticks.

## Local features: from cards to a plain checkmark bullet list

First pass (above) built the 10-item local showcase as bordered cards —
icon box, bold title, description paragraph, 2-column grid. Corrected on
follow-up request: the cards are gone entirely, replaced by a plain
`.local-features` checklist — one `<svg>` checkmark (same icon
`.price-features` already uses in the paid cards below) plus a single
condensed line of text per `<li>`, still 2 columns, no border/background/
hover-lift chrome at all. Each ten-item description got compressed from a
title+paragraph pair down to one line (e.g. "Resume review & fit-gate
ranking" + its explanatory sentence became "Resume review, backed by a
deterministic fit-gate score"). The whole page now reads as one
consistent checklist top to bottom rather than a card section sitting
above a card-based pricing grid.

This also made moot a fix from the first pass: the old `.local-item` card
had its own hover `transition` (lift + border-color) that collided with
`[data-reveal]`'s generic transition and needed a specificity workaround
(`.local-item[data-reveal]`, mirroring the `.hero-mockup-desktop`
pattern). Plain `<li>`s have no hover state of their own, so that
workaround was deleted along with the cards rather than carried forward
as dead weight.

**Reveal behavior, reverified after the rewrite** (not assumed to still
hold just because it held before): frame-by-frame sampling via
`requestAnimationFrame` on an off-screen `<li>` shows `opacity` at `0`
and `transform` at `scale(0.97) translateY(10px)` until scrolled into
view, then both ease smoothly to `1` / `scale(1) translateY(0)` over
consecutive frames — a real fade-and-rise, not an instant snap, confirmed
on the new markup, not inherited untested from the old.

## Local features: centered single column, and a real flex/inline-link bug

`.local-features` moved from a left-aligned 2-column grid to a single
centered column (`max-width: 38rem; margin: 0 auto`) — matches the
centered section heading above it instead of reading as a separately-
aligned block. Each row still lays out checkmark-then-text internally
(`text-align: left` on the `<li>`) so wrapped lines stay readable against
their own checkmark rather than centered as ragged text; it's the row as
a whole that's centered on the page, not the text within it.

**Real bug found while doing this, not just a styling tweak**: the first
bullet ("Every core feature... see Features") has an inline `<a>` link
inside it. Because `<li>` is `display: flex`, its raw text node and the
`<a>` were becoming two *separate* flex items — flex containers don't
lay out mixed text-and-inline-element content as normal wrapping prose,
each child (including anonymous text-node "children") becomes its own
flex item. Visually this meant "Features" detached from its sentence and
floated to a different position instead of flowing inline after "see."
Fixed by wrapping every `<li>`'s text content in a single `<span>`, so
each row is exactly two flex items (icon, text-span) and everything
inside the span flows as normal inline text, link included.

## Pricing tier rebalance: Intern narrowed, Pro broadened, Premier repriced

Operator feedback: the tiers didn't each carry distinct value — Intern's
feature list was close to feature-complete on its own, leaving Pro/Premier
to just add marginal items on top rather than each having a real reason to
exist. Rebalanced:

- **Intern** ($9/mo, unchanged) — scope narrowed from "Internship &
  new-grad postings" to **internship postings only**, tagline reworded to
  match ("For undergrads seeking internships — no matter where you are in
  your timeline"). **Automatic job status tracking moved out** of this
  tier entirely (see below) — Intern's list is now the deliberately
  smaller "starter" set: TUI/desktop, setup, 10/day, internship-only
  scope, hosted tailoring+review, Supabase storage, email support.
- **Pro** ($13/mo, unchanged) — **inherited the broader "internship &
  new-grad" scope** Intern gave up, quota raised from 10/day to
  **17/day**, and **picked up "automatic job status tracking from your
  account email"** (moved here from Intern, still tagged `Planned`) as
  its own distinguishing feature on top of the priority-search-refresh
  and multiple-resume-profiles it already had.
- **Premier** — tagline rewritten from a bare "For all." to "For every job
  seeker — any level, any market, no restrictions," and gained its own
  explicit scope bullet ("All experience levels & markets — not just
  internships or new grads") so its breadth is a stated feature, not just
  implied by the tier name. **Price lowered from $33/mo to $25/mo.**
  Quota (25/day) and its other perks (priority support, early access)
  unchanged.

Net effect: each tier now has at least one thing that's genuinely its own
rather than a strict superset of the tier below — Intern's narrow
internship-only focus, Pro's broader entry-level scope + status tracking,
Premier's full-market breadth + price point.

**Not reconciled elsewhere, flagged rather than silently left**: this is
the second pricing pass that moves further from
`docs/hosted-paid-tier-plan.md`'s original 3/10/25 capacity-analysis
numbers (now 10/17/25, and the free hosted tier that analysis assumed no
longer exists — see the previous restructure's own note on this). That
doc still hasn't been updated to match either pass.

## Product screenshots now render in both themes, not just dark

Superseded the earlier decision (above, in the `.feature-shot` capture
notes) to leave every embedded product screenshot dark regardless of
site theme "since it reads fine as a product shot sitting in a
light-mode card" — a real user reported it didn't: the screenshot stayed
visibly black against an otherwise-white page. Captured genuine
light-mode counterparts of all four screenshots (`desktop-home`,
`jobs-screen`, `resumes-screen`, `review-screen`) using the exact same
technique as the originals (Vite dev server + Playwright +
`window.__TAURI_INTERNALS__.invoke` stub), just with
`localStorage.aplyx.theme = 'light'` instead of `'dark'` and equivalent
mock data. Saved alongside the originals as `*-light.png`.

Every embed site — both `hero-mockup` figures and the `showcase-media`
feature-shots on `/`, all three `.feature-shot` rows plus the
`.feature-row-peek` thumbnail on `/features` — now wraps its `<img>` in
`.shot-stack`, a `display: grid` container holding both the dark and
light PNG stacked in the same grid cell (`grid-area: 1 / 1`), crossfaded
by `opacity` on the same `:root[data-theme="dark"]` /
`@media (prefers-color-scheme: dark)` dual guard already used for the
theme-toggle's sun/moon icon swap. A decorative `alt=""` on both stacked
images plus `role="img" aria-label="..."` on the wrapper (where the
original had real alt text) keeps screen readers from hearing the
screenshot's description twice. The opacity transition rides
`--duration-slow`/`--ease-standard`, so it also picks up a bit of extra
smoothing from the page's own root view-transition on toggle
(`site.js`'s `startViewTransition` call) without needing to coordinate
the two.

Verified live via Playwright: `color_scheme: "light"` renders 100%
light-shot opacity / 0% dark; `color_scheme: "dark"` (no explicit
toggle) renders the reverse; clicking `.theme-toggle` flips
`data-theme` and the computed opacities to match, confirming both the
OS-preference path and the explicit-choice path drive the same shots.

## Still open

- GitHub Pages enablement + Name.com DNS records (see "Deferred" above).
