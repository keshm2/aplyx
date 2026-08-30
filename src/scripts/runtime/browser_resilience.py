"""Shared browser-resilience helpers for the approve_submit_*.py runtimes
(docs/ats-account-credentials-plan.md Package 4). All four runtimes use
Playwright's SYNC API exclusively (no async_playwright anywhere in this
repo) — every helper here takes and returns sync Page/Locator objects.

This is a sibling to replay_fill.py, not an extension of it:
replay_fill.py's whole identity is "never submit, never decide" (see its
own module docstring); the concerns here — retrying a flaky click,
detecting a CAPTCHA/bot-check, checkpointing a repeated page signature —
are about surviving a real multi-step submission flow, which
replay_fill.py is deliberately not allowed to know about.

Design constraints straight from the plan's "Browser Runtime Resilience"
section:
- Bounded retries only (3 total attempts, ~500ms/1.5s/4s backoff with
  jitter) — never an unbounded loop.
- A retried action re-acquires its locator via a callback rather than
  reusing a handle, so a stale/detached element from a re-render is
  sidestepped by construction instead of needing separate detection.
- Final submit is a caller responsibility, never wrapped by anything
  here — retrying a submit click automatically is explicitly forbidden
  by the plan, so this module has no submit helper at all, only a
  detector the caller consults once before its own single direct
  `.click()`, exactly as every runtime does today.
- A checkpoint must carry a page signature, normalized URL, step name,
  and safe progress metadata, and must NEVER carry a password, OTP,
  cookie, or raw page dump. sanitize_checkpoint() is the one place that
  contract is enforced, so a field added to a state dict later can't
  silently leak into an on-disk checkpoint without passing through it.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Optional, TypeVar
from urllib.parse import urlsplit, urlunsplit

T = TypeVar("T")

# The plan's own numbers: 3 retries after the first attempt, delays of
# ~500ms/1.5s/4s. Jitter is +/-20% so concurrent runs against the same
# employer site don't retry in lockstep.
RETRY_DELAYS_MS: tuple[int, ...] = (500, 1500, 4000)


class TransientActionError(Exception):
    """Raised by a retryable action to mean 'the control was
    temporarily unavailable, try again' — distinct from a hard
    failure. Only this exception type triggers the bounded backoff
    loop in with_retry(); anything else propagates immediately and
    unretried, so a real bug (a typo'd selector, a logic error) fails
    fast instead of burning the whole retry budget pretending to be a
    transient flake."""


def _sleep_with_jitter(base_ms: int) -> None:
    jitter = base_ms * 0.2
    delay_ms = base_ms + random.uniform(-jitter, jitter)
    time.sleep(max(0.0, delay_ms) / 1000.0)


def sanitized_failure_category(exc: BaseException) -> str:
    """A short, safe-to-log/checkpoint failure category — the
    exception's class name only, never str(exc) (which can echo back
    page text, selector content, or form values)."""
    return type(exc).__name__


def with_retry(action: Callable[[], T], *, delays_ms: Iterable[int] = RETRY_DELAYS_MS) -> T:
    """Run `action`, retrying up to len(delays_ms) additional times on
    TransientActionError with bounded backoff+jitter. `action` must
    re-acquire any locator it touches itself (e.g. by calling
    page.locator(...) inside the closure) — that's what makes a retry
    immune to a stale-element error from the previous attempt's
    now-detached handle, rather than needing a separate stale-element
    detector."""
    delays = list(delays_ms)
    last_exc: Optional[BaseException] = None
    for attempt in range(len(delays) + 1):
        try:
            return action()
        except TransientActionError as exc:
            last_exc = exc
            if attempt >= len(delays):
                break
            _sleep_with_jitter(delays[attempt])
    assert last_exc is not None
    raise last_exc


def click_with_retry(locator_fn: Callable[[], object], *, timeout_ms: int = 2000, delays_ms: Iterable[int] = RETRY_DELAYS_MS) -> None:
    """Click a control, re-acquiring it via locator_fn() on every
    attempt (never reusing a stale handle across retries), bounded to
    len(delays_ms)+1 total attempts.

    Never use this for a final submit control. The plan forbids
    auto-retrying a submit click, and this helper has no concept of
    "is this the last step" — routing a submit through it would
    silently violate that rule. Call `.click()` directly for a final
    submit, exactly as every runtime does today.
    """

    def attempt() -> None:
        try:
            locator_fn().click(timeout=timeout_ms)
        except Exception as exc:
            raise TransientActionError(sanitized_failure_category(exc)) from exc

    with_retry(attempt, delays_ms=delays_ms)


# --- generic gate detection ------------------------------------------------

# Selectors indicating the page has put up something the runtime must
# never try to click through: a CAPTCHA/bot-check challenge, or a
# generic overlay that would intercept clicks meant for the form
# underneath it. This generalizes the recaptcha/hcaptcha-only checks
# Greenhouse/Lever/Ashby each had before Package 4, and fills a real
# gap in approve_submit_workday.py, which had no CAPTCHA detection of
# any kind.
_CHALLENGE_SELECTORS: tuple[str, ...] = (
    "textarea[name='g-recaptcha-response']",
    "input[name='g-recaptcha-response']",
    "iframe[src*='recaptcha']",
    ".g-recaptcha",
    "[data-sitekey]",
    "iframe[src*='hcaptcha']",
    ".h-captcha",
    "iframe[title*='challenge' i]",
    "#cf-challenge-running",
    "[id*='captcha' i]",
)


def detect_challenge(page) -> Optional[str]:
    """Returns a short reason string if the page is showing a
    CAPTCHA/bot-check/challenge overlay, else None. Callers must
    checkpoint-and-abort on a non-None result — this function only
    detects, it never decides to proceed, per the plan's "fail closed"
    requirement."""
    for selector in _CHALLENGE_SELECTORS:
        try:
            if page.locator(selector).count() > 0:
                return f"challenge marker matched: {selector}"
        except Exception:
            continue
    return None


# --- page signature / checkpoint ------------------------------------------

def normalize_url(url: str) -> str:
    """Strip the query string and fragment so two visits to the same
    step with different tracking params/anchors are recognized as the
    same page for signature purposes."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def page_signature(page, step_title: str) -> str:
    """A composite signature identifying "which step is this" —
    generalizes approve_submit_workday.py's existing
    `f"{step_title}::{page.url}"` so every runtime uses the exact same
    shape for repeated-signature loop detection."""
    return f"{step_title}::{normalize_url(page.url)}"


# Checkpoint key markers that must never reach disk, regardless of what
# a caller's state dict happens to contain — the one enforcement point
# for the plan's exclusion list ("must not include a password, OTP,
# verification link, cookie, or raw page dump"). Matched as a
# case-insensitive substring of
# the key name, not an exact list, so a variant name is still caught.
_FORBIDDEN_CHECKPOINT_KEY_MARKERS: tuple[str, ...] = ("password", "cookie", "session_token", "verification_link", "otp")
# A `*_hash` field is a one-way digest (e.g. an OTP idempotency check),
# never the secret itself — explicitly exempted so callers have a safe
# way to keep an audit trail without keeping the plaintext.
_ALLOWED_HASH_SUFFIX = "_hash"


def sanitize_checkpoint(state: dict) -> dict:
    """Strip any key matching a forbidden marker (password/OTP/
    verification-link/cookie/session-token) unless the key is explicitly a
    `*_hash` field. This
    is the single enforcement point every checkpoint-writing call site
    should pass its state dict through — a field added later can't
    silently leak a secret into the on-disk checkpoint without going
    through (and being caught by) this function."""
    clean: dict = {}
    for key, value in state.items():
        lowered = key.lower()
        if lowered.endswith(_ALLOWED_HASH_SUFFIX):
            clean[key] = value
            continue
        if any(marker in lowered for marker in _FORBIDDEN_CHECKPOINT_KEY_MARKERS):
            continue
        clean[key] = value
    return clean


@dataclass
class StepBudget:
    """Bounds the total number of page-advance steps a single run may
    take, independent of any per-call iteration cap — the plan's "stop
    after a total step budget to prevent loops." Raises StepBudgetExceeded
    rather than returning a sentinel, so a caller can't accidentally
    ignore it and keep looping."""

    max_steps: int
    taken: int = 0

    def consume(self) -> None:
        self.taken += 1
        if self.taken > self.max_steps:
            raise StepBudgetExceeded(f"step budget of {self.max_steps} exceeded")


class StepBudgetExceeded(Exception):
    pass
