# Real-time field clarification via Discord (with a local fallback)

> **Status: planning only, not started.** Captured from a conversation
> during the (since-implemented and removed) ATS account-credentials
> plan's Package 4/testing work (2026-08-23); no code has been written
> against this. Follow the
> repo's usual one-phase-at-a-time, explicit-go-ahead discipline
> (`docs/PLAN.md` §2) before implementing any of it.

## Context / the problem this solves

While live-testing the Workday login flow against a real NVIDIA
posting, `approve_submit_workday.py` correctly stopped rather than
guess when it hit two custom, employer-specific required questions
with no `SAFE_FIELD_LABELS` mapping ("How did you hear about us?":
a dropdown; "Have you previously worked for NVIDIA as an employee or
contractor?": Yes/No). Today the only way the user finds out is by
later noticing a checkpoint in the review queue; there's no live,
in-the-moment notification, and no way to answer it in the moment
either.

The operator wants: **the moment an application hits a field aplyx
can't answer, notify the user immediately with the actual question
and the actual options scraped from the page, and let them answer from
their phone**: a real-time, conversational version of what a human
was doing manually in that test session (I described the question, the
operator answered in chat, the script continued). Discord is the
requested first channel, with an explicit ask for a **central aplyx
bot** (not a per-user credential) that DMs each signed-in user, and a
fallback path for users who don't have Discord connected.

## Relationship to existing plans/patterns (read these first)

This is not a green field. Two things already exist that this design
must reuse rather than duplicate:

1. **`docs/sms-notifications-plan.md`** (planning-only, not built) is
   the closest prior art: a two-way SMS confirm-gate for the *local*
   scheduler-driven apply loop. It already settled several relevant
   questions and this plan should stay consistent with its reasoning
   or explicitly say why it diverges:
   - It explicitly rejected a **central, aplyx-owned relay** for SMS
     in favor of bring-your-own-Twilio, specifically to avoid needing
     "a permanently-running central service" (`sms-notifications-plan.md:33-38`).
     **This plan deliberately diverges from that for Discord; see
     "Why a central bot is the right call for Discord" below.** The
     reasoning that ruled out a central relay for phone numbers
     (a phone number is an individual resource; sharing one risks
     carrier filtering) does not transfer to Discord (a bot identity
     is inherently multi-tenant, and that's the platform's whole model).
   - It reuses `src/scripts/state/interest_letter.py`'s park/resume
     shape (request → user answers async → next run picks it up) as
     the established local convention for "can't safely answer this
     myself, ask the human, come back later." This plan's local-side
     mechanism should follow the same shape, not invent a fourth one.
   - It accepted **polling on the ~30-minute scheduler cadence** as
     the only way to get a reply back into a local, short-lived
     process without a new server. This plan's live-Workday-session
     case has a different constraint (see below) and can do
     meaningfully better than 30 minutes without needing new
     always-on infrastructure, because Discord's delivery model is
     different from SMS's.

2. **The existing Discord notification path** (`src/agents/bodies/discord-reporter.md`,
   `src/config/discord_config.json`) is a **one-way webhook**:
   `curl -X POST` to a per-install webhook URL, no bot, no token, no
   way to receive anything back. It cannot be extended into a
   two-way channel; a real Discord **bot application** (its own
   identity, its own token) is required regardless of central-vs-BYO.
   This plan's bot is a new, separate piece of infrastructure from
   the existing webhook-based outcome notifications; the two can
   coexist (a user could still have their own webhook for
   applied/failed/needs_review summaries, and separately be connected
   to the central aplyx bot for live field questions).

## Why a central bot is the right call for Discord

Unlike a phone number, a Discord bot's whole design is one identity
serving many users across many servers/DMs simultaneously; that's how
essentially every existing Discord bot works. Asking each user to
register their own Discord Application, generate a bot token, and
invite it somewhere is a real setup burden (Discord Developer Portal,
OAuth scopes, hosting their own token securely) for a feature whose
value is "get a question texted to you"; that burden would kill
adoption. A single aplyx-owned bot, where the user just accepts a
one-time connection, is both more in line with how users already
expect Discord bots to work and removes an entire category of setup
friction. Recommendation: **central bot, not BYO**, as the one
deliberate exception to the BYO-per-user pattern used everywhere else
in this repo's notification design.

## The key platform fact that changes the "no persistent server" constraint

The SMS plan needed polling because Twilio replies only arrive by
webhook (needs an always-on receiver) or by polling (works from a
short-lived process). Discord has a third option that neither SMS nor
plain webhooks have: **Interactions**. A message can carry buttons or
a select menu; when a user clicks one, Discord POSTs that click to a
registered **Interactions Endpoint URL**: a plain, stateless HTTPS
endpoint verified by an Ed25519 signature header, not a persistent
Gateway/WebSocket connection. This is exactly the shape of every Edge
Function this repo already runs (`inbound-email`,
`mail-connection-oauth-rpc`'s callback, `email-tracking-worker`): no
new *kind* of infrastructure, just one more Supabase Edge Function.

This means:
- **Sending** the DM (with buttons/select options) is a single
  outbound HTTPS call to Discord's REST API using the bot token,
  can be issued from anywhere, including directly from the local
  Python script the moment it hits the unmapped field. No server
  needed to send.
- **Receiving** the click is a stateless webhook (a new Edge
  Function, `discord-interactions`): always reachable the instant a
  user taps a button, not bounded by any polling cadence. This is the
  piece that requires *a* server, but it's the same server this repo
  already has (Supabase Edge Functions), not a new category of
  always-on process (no Gateway bot, no long-lived WebSocket).
- **Getting the answer back to the local script** still needs a
  bridge, because the script hit the field on the user's own machine,
  not inside Supabase. The Edge Function writes the answer to a
  hosted table; the local script (which is still alive, sitting in
  the browser session waiting) polls that table every few seconds.
  This is a **short, tight poll from a live process**, not a
  30-minute scheduler-cadence poll, so in practice this behaves as
  "real-time" from the user's perspective (answer arrives within
  seconds of them tapping the button) even though the mechanism is
  technically polling, not a push straight into the script.

## Proposed architecture

### Identity linking (new, hosted)

A new table, e.g. `discord_connections`:
```text
user_id uuid references auth.users
discord_user_id text not null
dm_channel_id text            -- cached, avoids re-opening a DM channel every send
connected_at timestamptz
```
Linking flow (needs a concrete UX decision, see "Decisions to
confirm"): most likely a `/link` slash command the user runs in a DM
with the aplyx bot, taking a short-lived code shown in the desktop
app's Settings (mirrors how many SaaS-plus-Discord-bot products do
account linking, and avoids needing the user to join a shared aplyx
Discord server if Discord's user-installable-app model (verify
current platform support at implementation time) allows DMing a user
who has only installed the app to their own account, not a server).

### Field-clarification request (new, hosted)

A new table, e.g. `field_clarification_requests`:
```text
id uuid
user_id uuid references auth.users
job_id text                    -- which application this is for
ats_family text
question text                  -- e.g. "How did you hear about us?"
option_kind text check (in ('select','yes_no','text'))
options jsonb                  -- scraped option labels, e.g. ["LinkedIn","Referral",...]
status text check (in ('pending','answered','expired','canceled'))
answer text
requested_at timestamptz
answered_at timestamptz
expires_at timestamptz
channel text check (in ('discord','none'))  -- 'none' when no channel is connected
```

### Send path (local → hosted → Discord)

1. `approve_submit_workday.py` (or any `approve_submit_*.py`) hits an
   unmapped required field, same detection point already used for
   `_validation_errors` after a Next/Continue click.
2. Calls a new SECURITY DEFINER RPC, e.g.
   `request_field_clarification(job_id, question, option_kind, options)`:
   inserts the row above, and internally triggers the Discord send
   (either the RPC calls out to the Discord REST API directly via
   `pg_net`/an HTTP extension, matching the pattern
   `email-tracking-worker`'s Gmail OAuth calls already use for
   external HTTP from Postgres, or the RPC just inserts the row and a
   tiny Edge Function trigger sends the DM; pick whichever the
   codebase's existing external-HTTP-from-Postgres precedent favors
   at implementation time).
3. If the user has no `discord_connections` row, the RPC returns
   `channel: 'none'` immediately; the local script falls straight
   back to today's checkpoint-and-stop behavior with no live wait.

### Local wait (real-time, from the user's perspective)

4. If a channel is live, the local script polls
   `get_field_clarification_answer(request_id)` every ~5s for up to a
   bounded window (10-15 minutes feels right, long enough to notice
   a phone buzz and tap a button, short enough not to leave a browser
   session and a person's attention hostage indefinitely; needs an
   operator decision, see below).
5. Answered → fill the field with the answer, continue the flow
   exactly where it left off, in the same browser session. This is
   the actual "real-time" experience the operator asked for.
6. Timed out → fall back to the existing checkpoint-and-stop
   behavior (same message as today, but now also mentioning "you'll
   get a Discord message" or "check Discord" since one was already
   sent). The request row stays `pending`; if the user answers on
   Discord *after* the local script gave up, the answer is still
   captured; the **next** "Continue Workday" run should check for an
   already-answered pending request for this job before attempting
   the field again, so a late reply isn't wasted (mirrors the SMS
   plan's "resolved-non-confirmed picked up on next run" idea).

### Receive path (Discord → hosted)

7. User taps a button/select option in the DM. Discord POSTs the
   interaction to the new `discord-interactions` Edge Function.
8. The function verifies the Ed25519 signature (required by Discord;
   an unverified endpoint gets suspended), maps the `custom_id` back
   to the `field_clarification_requests.id`, writes `answer`/
   `answered_at`/`status='answered'`, and responds to Discord with an
   updated message (e.g. edit the DM to show "You answered: LinkedIn ✅"
   so the user gets confirmation and can't double-tap).

## Fallback for users without Discord connected

Per the operator's ask, this needs *some* fallback, not silence. Given
the existing SMS plan already covers general outbound notifications
as its own opt-in channel, the fallback path for field-clarification
specifically should probably just be **today's existing behavior**:
checkpoint, stop, surface it in the review queue with a clear,
actionable message (the "leave a note for the human" behavior already
discussed and partially fixed in Package 4/5 testing this session).
Building a *second* new channel (e.g. push-notification-if-app-open)
as part of v1 is likely scope creep; recommend treating "checkpoint +
review queue" as the permanent fallback, and only reconsidering a
richer fallback if real usage shows Discord-linked users are a small
minority.

## Security considerations

- Never send a password, OTP, or any Vault-derived secret through a
  Discord message: this feature only ever carries the *question and
  its options*, scraped from a public-facing form, never anything
  credential-shaped. Add an explicit sanitize/deny-list check before
  sending (mirrors `browser_resilience.py`'s `sanitize_checkpoint`,
  same category of "never let this reach an external channel"
  discipline, applied to outbound Discord content instead of an
  on-disk checkpoint).
- Verify every Interactions payload's signature: this is a hard
  Discord requirement, not optional hardening; an endpoint that fails
  verification gets flagged and can be disabled by Discord itself.
- Rate-limit per user (a user with 10 simultaneous Workday
  applications shouldn't get 10 DMs in the same second); batch
  multiple pending questions from the same run into one message when
  possible.
- `field_clarification_requests` needs the same ownership-scoped RLS
  discipline as every other table in the ATS account-credentials work
  (`AGENTS.md`'s ATS account-credentials section; the design doc has
  since been implemented and removed): a user must never be able to
  read or answer another user's
  pending request, even by guessing an id.
- The `/link` code (or whatever linking mechanism is chosen) must be
  short-lived and single-use, same as any account-linking flow.

## Decisions to confirm before implementation

1. **Central bot vs. BYO for Discord**, recommended: central
   (argued above). Confirm.
2. **Linking UX**: slash-command-with-code vs. Discord OAuth2
   ("Login with Discord")-based linking vs. something else. OAuth2 is
   more standard and avoids the user ever needing to type a command,
   but adds an OAuth flow to build; a `/link <code>` command is
   simpler to implement first. Needs a decision, not just a default.
3. **Local poll window length**: proposed 10-15 minutes. Needs an
   operator number, not an assumption.
4. **Scope for v1**: Workday only (the only account-required,
   multi-step family today), or generalize the request/answer
   mechanism to the guest-flow families' pre-fill "doubt signal"
   stage too? Recommend Workday-only for v1: the guest families'
   doubt-signal routing already sends the job to `needs_review`
   cleanly with no live session to resume into, so there's less
   marginal value there for the added complexity.
5. **Hosted-worker integration**: this plan assumes the *local*
   interactive Workday flow, consistent with the fact that Package 7
   (an autonomous hosted status-checking worker) was explicitly
   deferred this session in favor of email-based tracking. If a
   hosted, unattended Workday worker is ever built later, it would
   need this same request/answer mechanism but with a much longer
   (or no) local poll; worth a forward-reference, not a blocker now.
6. **Does this replace or sit alongside the SMS plan?** Recommend
   alongside: Discord's button/select UX is a materially better fit
   for multiple-choice questions than SMS's free-text YES/NO, but SMS
   may still be the better channel for the SMS plan's own original
   use case (confirm-before-apply digests). Treat these as two
   channels for two different question shapes, not competing
   implementations of the same feature.
7. **What happens to a field-clarification request tied to a job
   that's no longer relevant** (posting closed, application
   abandoned): needs an expiry/cleanup story so `pending` rows and
   sent-but-unanswered DMs don't accumulate forever.

## Explicitly out of scope for v1 (per the decisions above, pending confirmation)

- SMS/other channels as a *fallback* for field clarification
  specifically (the existing checkpoint/review-queue path is the
  fallback; SMS notification mirroring is `sms-notifications-plan.md`'s
  own separate concern).
- Guest-flow (Greenhouse/Lever/Ashby) field clarification: those
  route through the existing doubt-signal → `needs_review` path, which
  has no live session to resume into.
- Any hosted, unattended worker consuming this mechanism (depends on
  a future decision to build Package 7-style autonomous status/apply
  workers at all).
- Free-text answers (only structured select/yes-no options in v1: a
  free-text Discord reply reintroduces the same "never guess what the
  user meant" ambiguity problem the SMS plan already flagged for YES/NO
  parsing, worse for open text).

## Suggested work packages (once decisions above are confirmed)

1. **Data model + RLS**: `discord_connections`,
   `field_clarification_requests`, ownership-scoped policies,
   same rollback-tested-migration discipline as the (since-implemented
   and removed) ATS account-credentials plan's packages.
2. **Discord bot app registration + linking flow** (whichever UX is
   chosen in decision 2) + the `discord-interactions` Edge Function
   (signature verification, answer-writing, DM-edit confirmation).
3. **Send path**: the `request_field_clarification` RPC/trigger,
   wired into `approve_submit_workday.py` at the point it already
   detects `_validation_errors`/an unmapped required field.
4. **Local poll + resume**: the bounded-wait loop in the Python
   script, plus the "check for an already-answered request before
   re-attempting a field" logic on a later Continue-Workday run.
5. **Settings UI**: a "Connect Discord" section (mirrors the existing
   Discord-webhook / planned-SMS Settings sections), showing link
   status and a disconnect action.
6. **Fallback verification**: confirm the no-channel-connected path
   behaves exactly like today's checkpoint (no regression), and that
   the review-queue message is clear when this is why a job stalled.
