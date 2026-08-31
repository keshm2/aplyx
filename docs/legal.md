# Legal / business structure notes

> **Not legal advice.** This is a plain-language writeup of a conversation
> about business structure, not counsel from an attorney or accountant.
> Treat it as a starting framework, not a final answer: confirm anything
> load-bearing (entity formation, liability specifics, tax treatment) with
> a real professional for your actual jurisdiction before acting on it.

## The question

Can aplyx ship as a product without forming a company first?

## Short answer

Yes, for the free/local tool, unconditionally. It gets more nuanced once
the paid hosted tier (`docs/hosted-paid-tier-plan.md`) goes live, because
that combination (real user PII, autonomous actions taken on someone's
behalf, and real payments) is exactly the scenario where operating
without a liability shield gets risky.

## Shipping the free, local tool today

No company needed at all. Publishing free software as an individual (same
as any open-source maintainer) requires no registration, no LLC, nothing.
This part is unambiguous.

## Once the paid hosted tier goes live

**Accepting payment as a sole proprietor is legal.** In the US, sole
proprietorship is the default legal status of an individual doing
business under their own name, no formal registration required (though
some states/cities want a business license or a DBA filing if operating
under a name other than your own). Stripe, already the billing processor
picked in `docs/hosted-paid-tier-plan.md`, explicitly supports
individual/sole-proprietor accounts. Plenty of solo indie SaaS founders
charge money this way.

**The real reason people form an LLC isn't legality or taxes: it's the
liability shield.** As a sole proprietor, there is no legal separation
between the individual and the business: if a bug in the auto-apply
pipeline mass-submits bad applications under someone's name to real
employers, or stored resumes/PII leak, or a billing dispute escalates,
personal assets (savings, etc.) are exposed, not just "the business."  An
LLC creates that separation.

**Tax-wise, a single-member LLC is usually treated identically to a sole
proprietorship by default** (pass-through to the individual's personal
return, no separate corporate tax filing required unless S-corp status is
elected). So the LLC isn't buying a tax advantage: it's buying the
liability wall specifically.

**Why this specific product sits in the risky category**: aplyx's hosted
tier plans to store real people's resumes/PII *and* take autonomous
real-world actions (submitting job applications) that can visibly misfire
in front of a real employer *and* processes real payments. That
three-way combination (PII custody + autonomous action + money changing
hands) is the textbook case where "just ship it as an individual" is the
risky path, as opposed to a stateless tool with no PII and no money
involved.

## Recommended sequencing

1. Ship the free/local tool as an individual now, no entity needed.
2. Form a simple single-member LLC before turning on real billing and
   storing real user PII in the hosted tier, not before. Typically a few
   hundred dollars and a couple hours of paperwork: DIY via the relevant
   state's Secretary of State site, or a formation service (Stripe Atlas,
   Firstbase, etc.) if a hands-off option is preferred.
3. Revisit before any of this: whether the existing `kredosai.com` email
   domain already implies an existing entity; if so, that might already
   cover this, or might be entirely unrelated to aplyx. Worth confirming
   directly rather than assuming either way.

## Open items, not yet resolved

- Which state/jurisdiction to form in, if/when the LLC step happens.
- Whether `kredosai.com` already corresponds to a registered entity, and
  if so, whether it's the right one to house aplyx's hosted tier under.
- Terms of Service / Privacy Policy drafting for the hosted tier, not
  covered here; a separate pass once the entity question is settled.
- Real attorney/accountant consultation before forming anything or
  accepting real payments: this document is a framework, not a
  substitute for that.
