---
name: humanizer
version: 1.0.0
scope: resume bullets and cover letters
used_by:
  - resume-tailor (Step 2 output — tailored_resume bullets, tailored_bullets)
  - cover-letter-tailor (final cover_letter text)
description: |
  Remove signs of AI-generated writing from resume bullets and cover
  letters before they're finalized — the same generic-verb-plus-inflated-
  metric template, buzzword stacking, and corporate throat-clearing a
  reviewer (human or ATS-adjacent) has seen a thousand times this month.
  Adapted from the repo-external general-purpose humanizer skill
  (~/.config/agent-workflows/skills/humanizer/SKILL.md, based on
  Wikipedia's "Signs of AI writing") for the specific shape of resume and
  cover-letter content.
---

# Humanizer (resume/cover-letter edition)

A final style pass over tailored bullets and cover-letter text, run
**after** content is decided and **before** it's returned as output.

## The one rule that overrides everything else here

**This is a style pass, never a content pass.** It changes word choice
and sentence shape. It never adds a fact, a number, a skill, or an
achievement that wasn't already there. If a bullet has no real metric
behind it, the fix is to describe the work concretely — not to invent a
percentage to sound more impressive, and not to reach for vague
inflation language as a substitute for a real number either. A humanized
lie is still a lie the applicant will be asked to defend in an
interview. `resume-tailor`'s and `cover-letter-tailor`'s own grounding
rules (never fabricate experience, a metric, or a skill) apply in full
here — this skill operates strictly inside that boundary.

## Resume bullet patterns

### 1. Power-verb rotation from the same small set

**Watch for:** Spearheaded, Orchestrated, Championed, Pioneered,
Architected (as a verb), Leveraged, Drove (non-literal), Galvanized —
especially when three or more bullets in the same tailored resume open
with different words from this exact set, which reads as a thesaurus
pass rather than a description of what happened.

**Before:**
> Spearheaded migration of the payments service to Kubernetes
> Orchestrated a cross-functional effort to reduce API latency
> Championed adoption of automated testing across the team

**After:**
> Migrated the payments service from EC2 to Kubernetes, cutting deploy time from 40 minutes to 6
> Worked with the platform and mobile teams to reduce checkout API latency
> Set up CI test coverage for the billing module after a production incident traced to an untested edge case

The second version is longer in places and shorter in others — real
work descriptions don't compress to a uniform length, and variation in
sentence shape is itself part of what reads as human-written.

### 2. The "Action + Task + resulting in [inflated metric]" template

**Watch for:** every bullet in the set following the identical shape
"Verb + object + resulting in/leading to/driving a [round number]%
[improvement]" — especially when the master resume's original bullet
had a different, more specific or more modest framing that got
rewritten to fit this template.

**Before:**
> Leveraged React and TypeScript to build a dashboard, resulting in a 40% increase in user engagement
> Utilized Python to automate reporting, resulting in a 30% reduction in manual work
> Implemented caching layer, resulting in a 25% improvement in response time

**After:**
> Built a dashboard in React/TypeScript that replaced three separate internal tools the team had been using
> Wrote a Python script to generate the weekly reporting deck automatically — previously took someone about half a day by hand
> Added a Redis cache in front of the product-lookup endpoint after profiling showed it as the slowest call on the page

If the master resume's bullet already had a real, specific number
(e.g. "cut p95 latency from 800ms to 220ms"), keep that number exactly —
don't round it, don't restate it as a percentage if the source didn't,
and don't add a second metric alongside it that isn't in the source.

### 3. Buzzword stacking

**Words to watch:** cutting-edge, synergy/synergistic, cross-functional
(when used as filler rather than naming the actual other team), dynamic,
robust, seamless(ly), end-to-end, best-in-class, state-of-the-art,
world-class, next-generation, holistic, game-changing, innovative
(as a self-description), scalable (when nothing about scale is actually
described).

**Before:**
> Built a seamless, end-to-end, cutting-edge data pipeline using state-of-the-art tools

**After:**
> Built a data pipeline using Airflow and dbt that ingests and transforms daily sales data from four source systems

### 4. Copula avoidance / corporate throat-clearing openers

**Watch for:** "Responsible for X", "Tasked with X", "Charged with X"
repeated as the opening of multiple bullets — these describe a job
description, not an accomplishment, and repetition of the exact phrase
across bullets is the tell.

**Before:**
> Responsible for managing the CI/CD pipeline
> Responsible for onboarding new engineers

**After:**
> Maintained the CI/CD pipeline (Jenkins → GitHub Actions migration in Q2)
> Wrote the onboarding guide new engineers now use in their first week

### 5. "Utilized"/"leveraged" instead of "used"

Nearly every instance of "utilized" or "leveraged" in a resume bullet
can become "used" or the specific verb for what was actually done
(built, wrote, configured, deployed, debugged, tested) without losing
any information — and reads less like it came out of a template.

### 6. Rule-of-three padding within one bullet

**Watch for:** three-item lists inside a single bullet where the third
item is generic filler added to complete the pattern ("...improving
performance, scalability, and maintainability" when only one of the
three was actually addressed).

**Before:**
> Refactored the auth module, improving performance, scalability, and maintainability

**After:**
> Refactored the auth module to remove a N+1 query that was the main source of slow login times

### 7. Em dash overuse and filler phrases

Same as general AI-writing patterns: prefer commas or separate
sentences over stacked em dashes; cut "in order to" → "to", "with the
goal of" → "to", "utilizing the ability to" → "could".

## Cover-letter patterns (in addition to the bullet patterns above)

Cover letters are prose, so the fuller set of patterns from the general
humanizer skill applies — the ones most likely to show up in a tailored
cover letter specifically:

- **Sycophantic/generic enthusiasm openers** ("I am thrilled/excited to
  apply for this incredible opportunity") — already disallowed by
  `cover-letter-tailor.md`'s own style rules; this is a second check,
  not a new rule.
- **Generic positive conclusions** ("I am confident I would be a great
  fit and look forward to contributing to your continued success") —
  replace with a concrete, specific closing tied to something in the JD.
- **Negative parallelism** ("It's not just about X, it's about Y") and
  **AI vocabulary words** (delve, align with, fostering, showcase,
  underscore, tapestry, testament, pivotal) — cut or replace with plain
  language.
- **Vague attributions about the company** ("known for its innovative
  culture") the letter has no actual source for — if `jd_text` didn't
  say it, don't say it (this is also a grounding-rule violation, not
  just a style one).

## Process

1. After drafting bullets (`resume-tailor`) or the letter
   (`cover-letter-tailor`), read back through the output once, specifically
   looking for the patterns above.
2. Rewrite flagged sections — change wording and structure only, never
   add or alter a fact, number, or claim.
3. Vary sentence length and opening word across bullets/paragraphs; five
   bullets that all start "Action-verb + object" in the same rhythm is
   itself a tell, independent of which verbs were chosen.
4. If a bullet has no real metric in the master resume, describe the
   concrete work instead of manufacturing a number or reaching for
   inflated adjectives to compensate.
5. Proceed to the normal output contract (resume-tailor's JSON object /
   cover-letter-tailor's `{"cover_letter", "word_count"}`) — this pass
   happens before that output is finalized, not as a separate step
   reported to the caller.
