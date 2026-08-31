#!/usr/bin/env python3
"""approve_submit_workday.py: local account/verification/submit runtime for
Workday applications.

Unlike the Greenhouse/Lever/Ashby runtimes (which start from a saved fill
record and go straight to submit), Workday needs account creation,
verification mail handling, and resumable multi-step page-fill checkpoints
before a final submit is safe. This script owns the local browser/account
side end-to-end:

- create or resume a per-job checkpoint under data/workday_apply_runs/
- fill a managed mail.aplyx.app alias into the account form
- submit account creation when the page is in create-account mode
- consume a forwarded verification link or OTP when available
- attempt login once the account is verified
- replay safe_fields across multi-step Workday form sections, advancing
  through Next/Continue until a review/submit page is reached
- attempt the final submit only when the page is clearly the final
  review/submit step, then detect success/failure

It fails closed on ambiguity: a submit that does not produce an
unambiguous confirmation is reported as submit_outcome_unclear and is NEVER
recorded as applied. The caller surfaces the structured status/message and
keeps the queue entry unresolved until a confirmed submit lands.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote, urlparse

from browser_resilience import (
    click_with_retry,
    detect_challenge,
    normalize_url,
    page_signature,
    sanitize_checkpoint,
)
from replay_fill import (
    DEFAULT_REVIEW_QUEUE,
    attach_resume,
    attach_transcript,
    default_chrome_user_data_dir,
    fill_field,
    find_queue_entry,
    is_profile_lock_error,
    resolve_resume_path,
    select_workday_listbox,
    try_combobox,
)

DEFAULT_STATE_DIR = "data/workday_apply_runs"
WORKDAY_HOST_SUFFIX = ".myworkdayjobs.com"
TARGETS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "src", "config", "targets.json")
DEFAULT_RESUME_PDF = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "data", "resumes", "resume.pdf")
MASTER_RESUME_JSON = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "data", "resumes", "resume.json")
SCREENSHOTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "data", "screenshots")
RECORD_FILL_SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "src", "scripts", "state", "record_fill.py")
DOCUMENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "data", "documents")


def _local_transcript_path() -> str | None:
    """The desktop app's Resume screen uploads at most one transcript,
    named transcript.<ext> (extension follows whatever the user picked;
    see importDocumentFile in src/core/src/bridge.ts). aplyx never
    parses this file; it's only ever handed to attach_transcript as-is."""
    try:
        for name in sorted(os.listdir(DOCUMENTS_DIR)):
            if name.startswith("transcript."):
                return os.path.join(DOCUMENTS_DIR, name)
    except OSError:
        pass
    return None

SAFE_FIELD_LABELS = {
    "first_name": ["First Name", "Legal First Name", "Given Name", "First (Given) Name"],
    "last_name": ["Last Name", "Legal Last Name", "Family Name", "Surname", "Last (Family) Name"],
    "preferred_name": ["Preferred Name", "Preferred First Name"],
    "email": ["Email", "Email Address", "Primary Email", "E-mail"],
    "phone": ["Phone", "Phone Number", "Mobile Phone", "Mobile", "Mobile Number", "Telephone"],
    "address_line1": ["Address Line 1", "Street Address", "Address", "Address 1", "Mailing Address", "Street"],
    "address_line2": ["Address Line 2", "Apartment", "Suite", "Unit", "Address 2", "Apt"],
    "location": ["City", "Location", "Current Location", "City/Town", "Municipality"],
    "state": ["State", "State/Province", "Region", "Province"],
    "zip_code": ["Postal Code", "Zip Code", "ZIP", "Postal", "Zip"],
    "linkedin_url": ["LinkedIn", "LinkedIn Profile", "LinkedIn URL", "LinkedIn Profile URL"],
    "github_url": ["GitHub", "GitHub Profile", "GitHub URL", "GitHub Profile URL"],
    "linkedin_username": ["LinkedIn Username", "LinkedIn Handle"],
    "github_username": ["GitHub Username", "GitHub Handle"],
    "graduation_date": ["Graduation Date", "Expected Graduation Date", "Date of Graduation", "Expected Graduation"],
    "gpa": ["GPA", "Grade Point Average", "GPA Score"],
    "authorized_to_work": ["Authorized to Work", "Work Authorization", "Authorized to work in the US", "Work Authorization Status", "Are you legally authorized to work in the United States?"],
    "require_sponsorship": ["Require Sponsorship", "Need Sponsorship", "Visa Sponsorship", "Will you now or in the future require sponsorship", "Sponsorship Requirement", "Do you need, or will you need in the future, any immigration related support or sponsorship"],
    "citizenship_status": ["Citizenship Status", "Citizenship", "Country of Citizenship"],
    "currently_enrolled": ["Currently Enrolled", "Enrollment Status"],
    # EEO / self-identification fields are only matched when the user
    # explicitly supplied a value in safe_fields; never defaulted here.
    "ethnicity": ["Ethnicity", "Race", "Ethnic Origin"],
    "hispanic_or_latino": ["Hispanic or Latino", "Are you Hispanic or Latino"],
    "gender": ["Gender", "Gender Identity"],
    "disability_status": ["Disability Status", "Disability", "Do you have a disability"],
    "veteran_status": ["Veteran Status", "Veteran", "Are you a veteran", "Military Service"],
    "date_of_birth": ["Date of Birth", "DOB", "Birth Date"],
}

# Workday's State dropdown typically shows the full name as its option
# text, not the 2-letter code the profile's "location" value carries;
# try_combobox/try_select_native require an exact option-text match, so
# the abbreviation alone would silently fail to match a real <select>.
US_STATE_ABBR_TO_NAME = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia",
}

CONSERVATIVE_DEFAULTS = [
    (
        "How Did You Hear About Us?",
        # User directive (2026-08-31): "Job Board" is the safest default
        # to always prefer when it's a real option: jobs aplyx applies to
        # are sourced from job-board-style listings, so it's truthful
        # across the widest range of postings, more so than assuming a
        # specific origin like "Company Career Site". Tenants phrase this
        # option differently for the same underlying facts, so several
        # truthful phrasings are tried in priority order until one
        # exact-matches a real option; never falls back to a phrasing
        # that isn't true. Capital One's real option list (confirmed
        # live, 2026-08-31) has neither "Job Board" nor "Company Career
        # Site"; only "Internet" is the truthful match there.
        ("Job Board", "Company Career Site", "Internet"),
        "category c: the required marketing/analytics question is answered truthfully from the Workday careers posting source",
    ),
    (
        "Phone Device Type",
        # User directive (2026-08-31): aplyx users' phone number is
        # always their mobile device: answer "Mobile" for this required
        # field rather than checkpointing as manual_required. Multiple
        # candidate phrasings for the same fact, same reasoning as "How
        # Did You Hear About Us?" above (tenants word this differently).
        ("Mobile", "Mobile Phone", "Cell", "Cell Phone"),
        "user directive 2026-08-31: aplyx users' phone number is their mobile device; always answer Mobile for this required Workday field",
    ),
]

# Workday's standard "My Information" listbox controls (`button[aria-
# haspopup="listbox"]`) expose no accessible name that get_by_label/
# get_by_role(name=...) can resolve: the visible label is a plain
# sibling text node, not an ARIA-associated one (confirmed live via a DOM
# dump against Capital One, 2026-08-31: the button's own aria-label IS
# present and does contain the label text, e.g. "State Select One
# Required", but Playwright's accessible-name matching still could not
# locate it; likely a conflicting aria-labelledby taking precedence over
# aria-label per the ARIA name-computation spec). These `name` attribute
# values are Workday's own internal field identifiers (part of the
# platform's shared data model, not this tenant's own choice), so they
# are a safe fallback CSS selector across tenants, not a per-tenant hack.
# Maps a SAFE_FIELD_LABELS key, or a CONSERVATIVE_DEFAULTS label, to its
# selector: tried only after the generic label-based match fails.
WORKDAY_STANDARD_LISTBOX_SELECTORS = {
    "state": "button[name='countryRegion']",
    "How Did You Hear About Us?": "button[name='source']",
    "Phone Device Type": "button[name='phoneType']",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _pause(base_ms: int, variance_ms: int) -> None:
    delay = max(0, base_ms + random.randint(-variance_ms, variance_ms)) / 1000.0
    time.sleep(delay)


def _looks_like_workday(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return False
    return host.lower().endswith(WORKDAY_HOST_SUFFIX)


def _state_path(out_dir: str, job_id: str) -> str:
    return os.path.join(out_dir, f"{job_id}.json")


def _load_state(out_dir: str, job_id: str) -> dict:
    path = _state_path(out_dir, job_id)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(out_dir: str, job_id: str, state: dict) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = _state_path(out_dir, job_id)
    # sanitize_checkpoint is a defensive backstop, not the primary
    # control; the primary control is that password/OTP are kept out
    # of `state` in the first place (see _load_local_password /
    # _save_local_password and the OTP-hash handling in run()). This
    # catches a future field added to `state` that forgets that rule,
    # per the plan's checkpoint exclusion list (never a password, OTP,
    # cookie, or raw page dump).
    state = {**sanitize_checkpoint(state), "updated_at": now_iso()}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
        fh.write("\n")
    return path


def _account_key(alias_email: str, apply_url: str) -> str:
    """Stable filesystem-safe key for a Workday account identity: the
    alias email plus the tenant host (e.g. capitalone.wd12.myworkdayjobs.com),
    not the job_id. Jobs sharing one Workday account (same alias + tenant)
    must reuse the same generated password sidecar so a login retry doesn't
    re-create a new account for an already-pending one. Hashed so the alias
    email isn't recoverable from the sidecar filename."""
    host = ""
    try:
        host = (urlparse(apply_url).hostname or "").lower()
    except ValueError:
        host = ""
    raw = f"{(alias_email or '').lower()}@{host}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _local_password_path(out_dir: str, account_key: str) -> str:
    return os.path.join(out_dir, ".secrets", f"{account_key}.json")


def _load_local_password(out_dir: str, account_key: str) -> str | None:
    """The Workday account password lives in its own sidecar file,
    never in the main checkpoint JSON that also carries page
    signatures, fill history, and verification metadata; the plan's
    checkpoint schema explicitly excludes passwords, and a real
    generated-then-forgotten password would otherwise have made every
    login retry re-create a new account instead of reusing the
    pending one. Keyed by account identity (alias email + tenant) so
    jobs sharing one Workday account reuse the same credentials. This
    is a deliberately narrow local-only stopgap: the plan's own "Local
    Install Strategy" section calls for this to move to the OS
    keychain, which is a separate, later package."""
    path = _local_password_path(out_dir, account_key)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return str(data.get("password")) if isinstance(data, dict) and data.get("password") else None
    except (OSError, json.JSONDecodeError):
        return None


def _save_local_password(out_dir: str, account_key: str, password: str) -> None:
    """Persist the Workday account password to its chmod-600 sidecar.

    Raises OSError on any I/O failure rather than silently swallowing it:
    a swallowed write would let run() proceed with a password that was never
    durably recorded, so a later continuation would regenerate a fresh
    credential and re-create the account instead of reusing the pending one.
    The caller (run) catches and checkpoints safely."""
    path = _local_password_path(out_dir, account_key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = json.dumps({"password": password})
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(payload)
    os.chmod(path, 0o600)


def _capture_checkpoint_screenshot(page, job_id: str) -> str | None:
    try:
        os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
        path = os.path.join(SCREENSHOTS_DIR, f"workday_{job_id}.png")
        page.screenshot(path=path, full_page=True)
        return os.path.relpath(path, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
    except Exception:
        return None


def _random_password() -> str:
    return f"{secrets.token_hex(8)}aA1!"


def _read_session_secret_file(path: str | None) -> tuple[str | None, str | None]:
    """Reads a one-time verification secret (link and/or OTP) from a file
    or stdin instead of argv, so the raw value never appears in a process
    argument list, shell history, or log snapshot. Accepts either a JSON
    object {"link": "...", "otp": "..."} or plain text (treated as an OTP
    when it looks like one, else a link). Returns (link, otp). A missing
    or unreadable file yields (None, None); the caller then checkpoints
    awaiting_verification, same as when no secret was supplied at all."""
    if not path:
        return None, None
    raw: str
    if path == "-":
        try:
            raw = sys.stdin.read().strip()
        except OSError:
            return None, None
    else:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                raw = fh.read().strip()
        except OSError:
            return None, None
    if not raw:
        return None, None
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return str(parsed.get("link") or None), str(parsed.get("otp") or None)
    except json.JSONDecodeError:
        pass
    # Plain text: a 4-8 digit run is an OTP, else a link.
    if re.fullmatch(r"\d{4,8}", raw):
        return None, raw
    if raw.lower().startswith("http"):
        return raw, None
    return None, raw


def _read_credential_file(path: str | None) -> tuple[str | None, str | None]:
    """Read a short-lived app credential handoff without accepting stdin or
    arbitrary formats. The caller fails closed when an explicitly supplied
    handoff cannot be read, rather than silently falling back to another
    credential source."""
    if not path or path == "-":
        return None, "credential handoff must be a local JSON file"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None, "credential handoff could not be read"
    password = parsed.get("password") if isinstance(parsed, dict) else None
    if not isinstance(password, str) or not password or "\n" in password or "\r" in password:
        return None, "credential handoff did not contain a valid password"
    return password, None


def _normalize_account_email(email: str | None) -> str:
    """Normalize an account/candidate email for sidecar keying and form
    fill: lowercased and trimmed so the same address supplied in
    different cases reuses one password sidecar per tenant."""
    return (email or "").strip().lower()


def _read_safe_fields() -> dict[str, str]:
    try:
        with open(TARGETS_PATH, "r", encoding="utf-8") as fh:
            targets = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    raw = targets.get("safe_fields") or {}
    usable: dict[str, str] = {}
    for key, value in raw.items():
        text = str(value or "").strip()
        if not text or text == "REPLACE_ME" or text.startswith("YOUR_"):
            continue
        usable[str(key)] = text
    return usable


def _resume_pdf_path(tailored: str | None = None) -> str | None:
    if tailored and os.path.exists(tailored):
        return tailored
    if os.path.exists(DEFAULT_RESUME_PDF):
        return DEFAULT_RESUME_PDF
    resolved = resolve_resume_path("resume.pdf")
    return resolved if resolved and os.path.exists(resolved) else None


def _locator(page, selector: str):
    loc = page.locator(selector)
    return loc if loc.count() > 0 else None


def _text_contains(page, fragments: list[str]) -> bool:
    try:
        body = (page.locator("body").inner_text(timeout=1000) or "").lower()
    except Exception:
        return False
    return any(fragment in body for fragment in fragments)


def _text_contains_all(page, fragments: list[str]) -> bool:
    try:
        body = (page.locator("body").inner_text(timeout=1000) or "").lower()
    except Exception:
        return False
    return all(fragment in body for fragment in fragments)


def _has_visible(page, selector: str) -> bool:
    try:
        loc = page.locator(selector)
        if loc.count() < 1:
            return False
        is_visible = getattr(loc.first, "is_visible", None)
        return bool(is_visible()) if callable(is_visible) else True
    except Exception:
        return False


def _has_any_visible(page, selectors: list[str]) -> bool:
    return any(_has_visible(page, selector) for selector in selectors)


EMAIL_INPUT_SELECTORS = [
    "[data-automation-id='email']",
    "input[type='email']",
    "input[type='text']",
    "input[name='email' i]",
    "input[name*='email' i]",
    "input[id*='email' i]",
    "input[aria-label*='email' i]",
    "input[placeholder*='email' i]",
]
PASSWORD_INPUT_SELECTORS = [
    "[data-automation-id='password']",
    "input[type='password']",
    "input[name='password' i]",
    "input[name*='password' i]",
    "input[id*='password' i]",
    "input[aria-label*='password' i]",
    "input[placeholder*='password' i]",
]
VERIFY_PASSWORD_INPUT_SELECTORS = [
    "[data-automation-id='verifyPassword']",
    "input[name*='verify' i][type='password']",
    "input[name*='confirm' i][type='password']",
]


def _account_mode(page) -> str:
    if _has_any_visible(page, VERIFY_PASSWORD_INPUT_SELECTORS):
        return "create_account"
    if _has_any_visible(page, PASSWORD_INPUT_SELECTORS) and _has_any_visible(page, EMAIL_INPUT_SELECTORS):
        return "login"
    if _text_contains_all(page, ["sign in", "email address", "password"]):
        return "login"
    return "unknown"


def _wait_for_account_mode_settled(page, timeout_s: float = 4.0) -> None:
    """Workday's sign-in/create-account form is client-rendered: a
    navigation's `wait_until="domcontentloaded"` plus the caller's fixed
    _pause fires before the form reliably exists in the DOM on a fresh
    (cold, no cached assets) browser profile. Poll briefly for a
    recognizable state before _account_mode's one-shot DOM check is
    trusted to gate the create_account/login branch; without this,
    _account_mode can read "unknown" on a page that is actually the
    login form mid-render, which skips the dedicated login-credential
    fill (email + password) entirely and falls through to the generic
    SAFE_FIELD_LABELS fill loop instead, which has no password field and
    can mis-fill the email field via label-substring collision (real bug
    found live against Capital One, 2026-08-31; see docs/NEXT_STEPS.md).
    Never raises; a timeout just leaves _account_mode's next real read to
    decide, same as before this existed."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if _account_mode(page) != "unknown" or _otp_mode(page) or _sign_in_choice_page(page):
                return
        except Exception:
            return
        time.sleep(0.2)


def _still_on_login_page(page) -> bool:
    """True if the page is still showing the login form (email + password
    fields both present). Used to avoid assuming a login succeeded when
    the submit was clicked but the form stayed put: wrong credentials, a
    validation error, or a CAPTCHA challenge all leave the login form
    on screen. Fails closed: any uncertainty returns False only when the
    login fields are clearly gone."""
    return _has_any_visible(page, PASSWORD_INPUT_SELECTORS) and _has_any_visible(page, EMAIL_INPUT_SELECTORS)


def _otp_mode(page) -> bool:
    selectors = [
        "input[name*='code' i]",
        "input[id*='code' i]",
        "input[data-automation-id*='code' i]",
        "input[name*='otp' i]",
        "input[id*='otp' i]",
        "input[data-automation-id*='otp' i]",
    ]
    for selector in selectors:
        if _has_visible(page, selector):
            return True
    return _text_contains(page, ["verification code", "one-time passcode", "enter code"])


def _verification_required(page) -> bool:
    return _otp_mode(page) or _text_contains(page, [
        "verify your email",
        "verify your email address",
        "check your email",
        "check your inbox",
        "verification email",
        "confirm your email address",
        "activate your account",
    ])


def _manual_required_reason(page) -> str | None:
    """Detect verification challenges that can NEVER be safely automated
    (TOTP/authenticator apps, push approvals, security/hardware keys, SSO,
    or an unrecognized MFA page). Returns a short label when one is
    detected, None otherwise. The caller checkpoints `manual_required`
    with this reason; never guesses, never claims verified/submitted on
    a challenge it cannot cross. Mirrors the hosted worker's
    detectManualRequired vocabulary so the two paths agree on taxonomy."""
    if _text_contains(page, [
        "authenticator app", "authenticator code",
        "approve sign in", "approve sign-in", "approve login", "approve request",
        "push notification", "deny sign in", "deny sign-in",
        "security key", "yubikey",
        "single sign-on", "sign in with google", "sign in with microsoft",
        "sign in with okta", "sign in with sso",
        "multi-factor", "multi factor", "mfa",
    ]):
        try:
            body = (page.locator("body").inner_text(timeout=1000) or "").lower()
        except Exception:
            return "unsupported_mfa"
        if "authenticator" in body:
            return "totp"
        if "approve" in body or "push" in body:
            return "push_approval"
        if "security key" in body or "yubikey" in body:
            return "security_key"
        if "single sign" in body or "sign in with" in body or " sso" in body:
            return "sso"
        return "unsupported_mfa"
    return None


def _workday_step_title(page) -> str:
    # progressBarActiveStep is checked first: a real live-site finding
    # (2026-08-23, NVIDIA's Workday tenant) is that the multi-step apply
    # wizard doesn't change the URL between internal steps at all (it's
    # a client-side-only stepper) and none of the selectors below
    # actually match this employer's page, causing every step to
    # report the same generic page title. Since _page_signature combines
    # this title with the URL for loop detection, that combination made
    # every genuinely different step look identical: a false "stuck in
    # a loop" stop on real forward progress. progressBarActiveStep's
    # text is "current step N of M\n<Step Name>"; take the last
    # non-empty line so the step count doesn't get folded into the name.
    try:
        active = page.locator("[data-automation-id='progressBarActiveStep']")
        if active.count() > 0:
            text = (active.first.inner_text(timeout=700) or "").strip()
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            if lines:
                return lines[-1]
    except Exception:
        pass

    selectors = [
        "[data-automation-id='pageHeader']",
        "[data-automation-id='jobPostingHeader']",
        "h1",
        "h2",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            if loc.count() > 0:
                text = (loc.first.inner_text(timeout=700) or "").strip()
                if text:
                    return text
        except Exception:
            continue
    return ""


def _fill_if_visible(page, selector: str, value: str) -> bool:
    try:
        loc = page.locator(selector)
        if loc.count() < 1:
            return False
        loc.first.fill(value)
        return True
    except Exception:
        return False


def _click_if_visible(page, selector: str) -> bool:
    try:
        loc = page.locator(selector)
        if loc.count() < 1:
            return False
        loc.first.click(timeout=1500)
        return True
    except Exception:
        return False


_LABEL_TO_SAFE_KEY: dict[str, str] | None = None


def _label_to_safe_key(label: str) -> str | None:
    global _LABEL_TO_SAFE_KEY
    if _LABEL_TO_SAFE_KEY is None:
        mapping: dict[str, str] = {}
        for key, labels in SAFE_FIELD_LABELS.items():
            for candidate in labels:
                mapping.setdefault(candidate, key)
        _LABEL_TO_SAFE_KEY = mapping
    return _LABEL_TO_SAFE_KEY.get(label)


def _build_fill_record_fields(state: dict, safe_fields: dict[str, str]) -> list[dict]:
    """Reconstructs a record_fill.py-compatible fields array from this
    run's accumulated fill_history: so a needs-review checkpoint carries
    a fill_record_path showing everything aplyx already filled, not a
    blank form (user directive, 2026-08-31: "things like these should
    land in review queue with everything else that aplyx can fill out
    pre-filled out").

    Only two sources are reconstructable without a structural change to
    _fill_workday_page's return shape (it reports filled LABELS, not the
    values behind them): SAFE_FIELD_LABELS-driven fills, reverse-mapped
    from label text back to the safe_fields key that supplied the value,
    and conservative_defaults, which already carry the full record shape.
    Every entry is marked verified=False: the value was successfully
    written via the browser fill call, but this reconstruction does not
    re-read the DOM to confirm it still matches, so it does not claim
    record_fill.py schema's stronger "verified" guarantee.
    """
    seen: set[str] = set()
    fields: list[dict] = []
    for fill_result in state.get("fill_history") or []:
        for label in fill_result.get("filled_labels") or []:
            key = _label_to_safe_key(label)
            value = safe_fields.get(key, "") if key else ""
            if not key or not value or key in seen:
                continue
            seen.add(key)
            fields.append({"field_name": label, "filled_value": value, "source": f"safe_fields:{key}", "verified": False})
        for cd in fill_result.get("conservative_defaults") or []:
            name = cd.get("field_name")
            if not name or name in seen:
                continue
            seen.add(name)
            fields.append({
                "field_name": name,
                "filled_value": cd.get("filled_value", ""),
                "source": "conservative_default",
                "note": cd.get("note", ""),
                "verified": False,
            })
    return fields


def _maybe_record_fill(job_id: str, state: dict, safe_fields: dict[str, str]) -> str | None:
    """Calls record_fill.py (the canonical fill-record helper, AGENTS.md
    "Fill records") when at least one field was filled this run, returning
    the fill_record_path to carry into the checkpoint result verbatim, per
    AGENTS.md: "For a Workday job whose runtime returned a
    fill_record_path, carry it through verbatim: the runtime owns the
    fill record for the Workday flow." Building the actual review_queue.json
    row (company/title/ats_score/etc.) stays the orchestrator's job; this
    script only owns proving what it actually filled. Returns None (never
    raises) when there's nothing to record or the helper call fails, so a
    fill-record problem never blocks the checkpoint itself from reaching
    the user."""
    fields = _build_fill_record_fields(state, safe_fields)
    if not fields:
        return None
    try:
        result = subprocess.run(
            [sys.executable, RECORD_FILL_SCRIPT, "record", job_id, json.dumps(fields)],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            return None
        payload = json.loads((result.stdout or "").strip().splitlines()[-1])
        return payload.get("path") or None
    except Exception:
        return None


def _write_result(ok: bool, message: str, **extra) -> int:
    payload = {"ok": ok, "message": message, **extra}
    print(json.dumps(payload))
    return 0 if ok else 1


def _emit_with_checkpoint(page, state_dir: str, job_id: str, state: dict, ok: bool, message: str, **extra) -> int:
    screenshot_path = _capture_checkpoint_screenshot(page, job_id)
    if screenshot_path:
        state["screenshot_path"] = screenshot_path
        extra.setdefault("screenshot_path", screenshot_path)
    # Surface whether the runtime actually consumed the verification
    # link/OTP it was passed, so helpers/ReviewScreen can mark the
    # matching inbound_emails row consumed. These are boolean flags
    # set in `state` during run(); emit them on every result so a
    # continuation that crossed verification reports it even when the
    # outcome is a later checkpoint (page_filled, ready_to_submit, etc.).
    if state.get("used_verification_link"):
        extra.setdefault("used_verification_link", True)
    if state.get("used_verification_otp"):
        extra.setdefault("used_verification_otp", True)
    checkpoint = _save_state(state_dir, job_id, state)
    extra.setdefault("checkpoint", checkpoint)
    extra.setdefault("checkpoint_status", state.get("status"))
    return _write_result(ok, message, **extra)


def _apply_entry(job_id: str, review_queue_path: str, apply_url: str | None) -> dict:
    """Resolve a posting for a fresh scheduled run or queue continuation."""
    if apply_url:
        return {"job_id": job_id, "apply_url": apply_url, "url": apply_url}
    return find_queue_entry(job_id, review_queue_path)


def _workday_login_url(apply_url: str) -> str:
    """Builds a continuation-run login URL that includes the tenant's site
    segment (e.g. "/Capital_One"), not just a bare "/login" at the domain
    root. The site segment is whatever path segment(s) precede "job":
    this generalizes the previous "/search/"-only split (which handled a
    "/<site>/search/job/..." shape but produced a site-less "/login" for
    any tenant whose apply path is just "/<site>/job/...", Capital One
    included). A site-less login URL is one Workday's own auth flow can't
    resolve post-login: it silently bounces to
    community.workday.com/invalid-url instead of the job application
    (real bug found live against Capital One, 2026-08-31; see
    docs/NEXT_STEPS.md)."""
    parsed = urlparse(apply_url)
    path = parsed.path.rstrip("/")
    target_path = f"{path}/apply/autofillWithResume"
    segments = [s for s in path.split("/") if s]
    site_prefix = ""
    if "job" in segments:
        job_idx = segments.index("job")
        if job_idx > 0:
            site_prefix = "/" + "/".join(segments[:job_idx])
    login_path = f"{site_prefix}/login" if site_prefix else "/login"
    return f"{parsed.scheme}://{parsed.netloc}{login_path}?redirect={quote(target_path, safe='')}"


def _normalize_profile_url(key: str, value: str) -> str:
    if key != "linkedin_url":
        return value
    try:
        parsed = urlparse(value)
    except ValueError:
        return value
    if (parsed.hostname or "").lower() != "linkedin.com":
        return value
    return parsed._replace(scheme="https", netloc="www.linkedin.com").geturl()


def _fill_first_visible(page, selectors: list[str], value: str) -> bool:
    for selector in selectors:
        if _fill_if_visible(page, selector, value):
            return True
    return False


def _fill_account_credentials(page, email: str, password: str, *, include_confirmation: bool = False) -> None:
    _fill_first_visible(page, EMAIL_INPUT_SELECTORS, email)
    _pause(220, 60)
    _fill_first_visible(page, PASSWORD_INPUT_SELECTORS, password)
    if include_confirmation:
        _pause(220, 60)
        _fill_first_visible(page, VERIFY_PASSWORD_INPUT_SELECTORS, password)


def _submit_login(page) -> bool:
    if _click_if_visible(page, "[data-automation-id='click_filter'][aria-label='Sign In']"):
        return True
    if _click_if_visible(page, "[data-automation-id='submitButton']"):
        return True
    if _click_labeled(page, ["Sign In", "Log In", "Login"], roles=("button",), timeout=2500):
        return True
    return _click_if_visible(page, "button[type='submit']")


def _next_button(page):
    selectors = [
        "[data-automation-id='bottom-navigation-next-button']",
        "[data-automation-id='nextButton']",
        "[data-automation-id='pageFooterNextButton']",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            if loc.count() > 0:
                return loc.first
        except Exception:
            continue
    names = ["Next", "Continue", "Review and Submit", "Review"]
    for name in names:
        try:
            loc = page.get_by_role("button", name=name, exact=False)
            if loc.count() > 0:
                return loc.first
        except Exception:
            continue
    return None


def _has_any_visible_field(page) -> bool:
    return _has_any_visible(page, [
        "input:not([type='hidden']):not([type='file'])",
        "select",
        "textarea",
        "[role='combobox']",
        "[role='listbox']",
    ])


def _wait_for_application_control(page, timeout_seconds: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    control_seen_at: float | None = None
    while time.monotonic() < deadline:
        if _submit_button(page) is not None or _next_button(page) is not None:
            if control_seen_at is None:
                control_seen_at = time.monotonic()
            # Workday's page chrome (the Next/Submit footer) and its
            # data-driven field section are separate components: the
            # footer can render, and be found here, before a single field
            # behind it exists in the DOM. Give the fields a brief extra
            # grace window instead of returning the instant a control
            # appears; only give up waiting for a field after 1.5s in case
            # this control legitimately guards a page with no fields at
            # all (e.g. a pure review/submit step). Real bug found live
            # against Capital One's "My Information" step, 2026-08-31:
            # _fill_workday_page ran on a control-only, field-less DOM and
            # every SAFE_FIELD_LABELS key came back unmatched.
            if _has_any_visible_field(page) or (time.monotonic() - control_seen_at) > 1.5:
                return
        elif _account_mode(page) != "unknown" or _otp_mode(page):
            return
        _pause(200, 0)


def _apply_entry_button(page):
    selectors = [
        "[data-automation-id='applyManually']",
        "[data-automation-id='applyButton']",
        "a[data-automation-id*='apply' i]",
        "button[data-automation-id*='apply' i]",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            if loc.count() > 0:
                return loc.first
        except Exception:
            continue
    for role in ("button", "link"):
        for name in ["Apply", "Apply Now", "Start Application"]:
            try:
                loc = page.get_by_role(role, name=name, exact=False)
                if loc.count() > 0:
                    return loc.first
            except Exception:
                continue
    return None


def _application_start_modal(page) -> bool:
    return _text_contains(page, ["start your application", "autofill with resume", "apply manually"])


def _sign_in_choice_page(page) -> bool:
    return _text_contains(page, ["sign in with google", "sign in with email"]) 


def _click_labeled(page, labels: list[str], *, roles=("button", "link"), timeout: int = 2000) -> bool:
    for role in roles:
        for name in labels:
            try:
                loc = page.get_by_role(role, name=name, exact=False)
                if loc.count() > 0:
                    loc.first.click(timeout=timeout)
                    return True
            except Exception:
                continue
    return False


def _prefer_resume_start(page) -> bool:
    return _click_labeled(page, ["Autofill with Resume", "Autofill with resume"]) 


def _fallback_manual_start(page) -> bool:
    return _click_labeled(page, ["Apply Manually", "Apply manually"]) 


def _choose_create_account(page) -> bool:
    labels = [
        "Create Account",
        "Create account",
        "Don't have an account? Create Account",
        "Don’t have an account? Create Account",
        "Create one",
        "Sign up",
    ]
    if _click_labeled(page, labels):
        return True
    selectors = [
        "[data-automation-id='createAccountLink']",
        "a[data-automation-id*='create' i]",
        "button[data-automation-id*='create' i]",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            if loc.count() > 0:
                loc.first.click(timeout=2000)
                return True
        except Exception:
            continue
    return False


def _switch_to_apply_manually_url(page) -> bool:
    """NVIDIA's Workday flow exposes both /apply/autofillWithResume and
    /apply/applyManually entry points. If the autofill path lands on a sign-in
    choice page with no visible create-account route, fall back to the manual
    path explicitly rather than looping on the same wall. Best-effort and
    deterministic: only rewrite the URL when we're already on an autofill path
    and the manual sibling is obvious from the URL shape."""
    try:
        url = page.url
    except Exception:
        return False
    if "/apply/autofillWithResume" not in url:
        return False
    manual_url = url.replace("/apply/autofillWithResume", "/apply/applyManually")
    if manual_url == url:
        return False
    try:
        page.goto(manual_url, wait_until="domcontentloaded")
        _pause(1400, 260)
        return True
    except Exception:
        return False


def _looks_like_blank_autofill_shell(page, fill_result: dict) -> bool:
    """NVIDIA's autofillWithResume path can land on a shell page with the
    progress rail visible but no actionable controls or form fields. Detect
    that narrowly so we can fall back to the sibling applyManually path rather
    than checkpointing an obviously stuck state forever."""
    try:
        url = page.url
    except Exception:
        return False
    if "/apply/autofillWithResume" not in url:
        return False
    if fill_result.get("filled_labels") or fill_result.get("resume_attached"):
        return False
    if _account_mode(page) != "unknown" or _otp_mode(page) or _sign_in_choice_page(page):
        return False
    if _submit_button(page) is not None or _next_button(page) is not None:
        return False
    return True


def _submit_create_account(page) -> bool:
    if _click_if_visible(page, "[data-automation-id='submitButton']"):
        return True
    if _click_labeled(page, ["Create Account", "Create account"], roles=("button",), timeout=2500):
        return True
    selectors = [
        "button[type='submit']",
        "button[data-automation-id*='submit' i]",
        "button[data-automation-id*='create' i]",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            if loc.count() > 0:
                loc.first.click(timeout=2500)
                return True
        except Exception:
            continue
    return False


def _submit_button(page):
    """Final application-submit control only: never the public posting
    `Apply` link. Workday surfaces submit buttons on account-creation and
    intermediate steps too, and the public posting page has its own `Apply`
    control that opens the application flow; matching either by name would
    let a non-final page read as ready-to-submit. Prefer explicit Workday
    automation IDs, then the narrow `Submit`/`Submit Application` button
    names. The caller still gates the actual click behind
    `_is_review_submit_page`: this selector just refuses to hand back a
    control that is obviously not a final submit."""
    selectors = [
        "[data-automation-id='submitButton']",
        "[data-automation-id='bottom-navigation-submit-button']",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            if loc.count() > 0:
                return loc.first
        except Exception:
            continue
    for name in ["Submit Application", "Submit"]:
        try:
            loc = page.get_by_role("button", name=name, exact=False)
            if loc.count() > 0:
                return loc.first
        except Exception:
            continue
    return None


def _is_review_submit_page(page) -> bool:
    """True only when the page is clearly the final review/submit page, not
    just any page that happens to have a submit button. Workday surfaces
    submit buttons on account-creation and intermediate steps too, so a
    submit button alone is not enough: clicking submit on a non-final page
    is not a real application submit. Fails closed: returns False on any
    ambiguity so the caller saves a checkpoint for human review instead."""
    try:
        body = (page.locator("body").inner_text(timeout=1000) or "").lower()
    except Exception:
        return False
    review_markers = [
        "review your application",
        "review and submit",
        "submit your application",
        "submit application",
        "review your submission",
        "please review",
        "review the information",
        "final review",
        "review your information",
        "verify and submit",
        "confirm and submit",
        "review your details",
    ]
    return any(marker in body for marker in review_markers)


def _validation_errors(page) -> list[str]:
    errors: list[str] = []
    selectors = [
        "[aria-invalid='true']",
        "[data-automation-id*='error' i]",
        "[data-automation-id='validationError']",
        ".error",
        ".field-error",
        "[class*='errorMessage' i]",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            count = min(loc.count(), 5)
            for i in range(count):
                text = (loc.nth(i).inner_text(timeout=500) or "").strip()
                if text:
                    errors.append(text)
        except Exception:
            continue
    return errors


def _looks_successful(page) -> tuple[bool, str]:
    """Returns (confirmed_success, reason). Fails closed: only True on an
    unambiguous confirmation (a success phrase in the body or a redirect to
    a non-posting applications/thank-you URL). Anything ambiguous is False
    so the caller records submit_outcome_unclear instead of 'applied'."""
    body = ""
    try:
        body = (page.locator("body").inner_text(timeout=1000) or "").lower()
    except Exception:
        body = ""
    url = page.url.lower()
    success_phrases = [
        "your application has been submitted",
        "application submitted",
        "thank you for applying",
        "thanks for applying",
        "thank you for your application",
        "thank you for submitting",
        "application received",
        "we've received your application",
        "we have received your application",
        "we received your application",
        "submission received",
        "successfully submitted",
        "application was submitted",
        "application is complete",
        "application complete",
        "submission complete",
        "you've applied",
        "successfully applied",
    ]
    for phrase in success_phrases:
        if phrase in body:
            return True, f"Workday confirmation detected: {phrase}"
    # Workday often redirects to a per-user applications dashboard or a
    # confirmation URL after a successful submit, and those live on
    # myworkdayjobs.com too, so excluding that host (as this once did)
    # missed real confirmations. Require a clear post-submit path
    # segment AND that we are no longer on the apply form itself, so an
    # apply-form URL that happens to contain a matching segment never
    # reads as a false success. Still fail-closed: anything ambiguous
    # falls through to outcome_unclear.
    post_submit_segments = (
        "/thankyou",
        "/thank-you",
        "/confirmation",
        "/submitted",
        "/applicationcomplete",
        "/application-complete",
        "/applications",
    )
    if any(seg in url for seg in post_submit_segments) and "/apply" not in url:
        return True, f"Workday redirected to a confirmation URL: {page.url}"
    return False, "submit did not reach an obvious Workday confirmation state"


def _attempt_final_submit(page, submit) -> dict:
    """Clicks the final submit button and polls for an unambiguous outcome.
    Returns a dict with: outcome ('submitted' | 'validation_error' |
    'outcome_unclear' | 'click_failed' | 'challenge_detected'), reason,
    confirmation_url. Never claims success on ambiguity: outcome_unclear
    is the fail-closed path. The click itself is a single direct
    `.click()`, never wrapped in click_with_retry: the plan forbids
    auto-retrying a final submit, so this is the one action in the whole
    file that must never gain a retry wrapper."""
    challenge = detect_challenge(page)
    if challenge:
        return {"outcome": "challenge_detected", "reason": f"challenge detected before final submit: {challenge}", "confirmation_url": page.url}
    try:
        submit.click(timeout=2000)
    except Exception as exc:
        return {"outcome": "click_failed", "reason": f"final submit button could not be clicked: {exc}", "confirmation_url": page.url}
    _pause(1600, 300)

    errors = _validation_errors(page)
    if errors:
        return {"outcome": "validation_error", "reason": f"submit surfaced validation issues: {'; '.join(errors[:3])}", "confirmation_url": page.url, "errors": errors}

    deadline = time.monotonic() + 12.0
    while time.monotonic() < deadline:
        ok, reason = _looks_successful(page)
        if ok:
            return {"outcome": "submitted", "reason": reason, "confirmation_url": page.url}
        _pause(400, 100)

    return {"outcome": "outcome_unclear", "reason": "submit was clicked but the resulting page did not show an unambiguous confirmation: NOT recorded as applied", "confirmation_url": page.url}


def _paste_cover_letter(page, cover_letter: str) -> bool:
    """Paste a tailored cover letter into a Workday cover-letter field if
    one is visible on the current step. Workday surfaces this as a textarea
    labeled 'Cover Letter' or a content-editable region; if no such field is
    present, returns False (the letter simply isn't used, not an error,
    since many Workday postings have no cover-letter field at all)."""
    textarea_selectors = [
        "textarea[name*='cover' i]",
        "textarea[id*='cover' i]",
        "textarea[aria-label*='cover letter' i]",
        "textarea[data-automation-id*='cover' i]",
    ]
    for selector in textarea_selectors:
        if _fill_if_visible(page, selector, cover_letter):
            return True
    # Fall back to a label-based fill so a Workday variant that labels
    # the field 'Cover Letter' but uses a generic textarea is still caught.
    status, _ = fill_field(page, "Cover Letter", cover_letter)
    return status == "filled"


# --- Master resume / My Experience structured fill -----------------------


def _read_preferred_locations() -> list[str]:
    """Load preferred_locations from targets.json. Returns [] on any
    read/parse failure: callers must handle the empty case."""
    try:
        with open(TARGETS_PATH, "r", encoding="utf-8") as fh:
            targets = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []
    raw = targets.get("preferred_locations") or []
    return [str(item).strip() for item in raw if str(item).strip()]


def _load_master_resume() -> dict:
    """Load the master resume JSON (data/resumes/resume.json). Returns {}
    on any read/parse failure: callers must handle the empty case and
    never fabricate data."""
    try:
        with open(MASTER_RESUME_JSON, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _normalize_text(s: str) -> str:
    """Normalize for matching: lowercase, collapse whitespace, strip."""
    return " ".join((s or "").lower().split())


_MONTH_NAMES = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}


def _parse_single_date(s: str) -> tuple[str | None, str | None]:
    """Parse 'Jun 2025' or 'Present' into (month, year). 'Present' yields
    (None, None); the caller treats a missing end date as 'currently
    works here'. Returns (None, None) on any parse failure: never guesses."""
    tokens = (s or "").strip().split()
    if not tokens:
        return None, None
    if len(tokens) >= 2:
        month_key = tokens[0].lower()
        year = tokens[1]
        if month_key in _MONTH_NAMES and year.isdigit() and len(year) == 4:
            return str(_MONTH_NAMES[month_key]), year
    if len(tokens) == 1 and tokens[0].isdigit() and len(tokens[0]) == 4:
        return None, tokens[0]
    return None, None


def _parse_resume_date_range(dates_str: str) -> tuple[str | None, str | None, str | None, str | None]:
    """Parse a resume date range like 'Jun 2025 – Present' or
    'Jun 2024 – Oct 2024' into (start_month, start_year, end_month, end_year).
    Returns (None, None, None, None) on any parse failure: never guesses."""
    if not dates_str:
        return None, None, None, None
    raw = dates_str.replace("–", "-").replace("\u2014", "-")
    parts = [p.strip() for p in raw.split("-") if p.strip()]
    if len(parts) != 2:
        return None, None, None, None
    start_m, start_y = _parse_single_date(parts[0])
    end_m, end_y = _parse_single_date(parts[1])
    return start_m, start_y, end_m, end_y


def _map_degree_to_workday(degree_str: str) -> str | None:
    """Map a free-text degree string to one of Workday's exact dropdown
    options (GED, High School, Associates, Bachelors, Masters, Doctorate).
    Returns None if no confident mapping exists: never guesses."""
    s = (degree_str or "").lower().strip()
    if not s:
        return None
    if any(k in s for k in ("b.s.", "b.s ", "b.a.", "b.a ", "bachelor of", "bachelor's", "bachelors", "bachelor")):
        return "Bachelors"
    if any(k in s for k in ("m.s.", "m.s ", "m.a.", "m.a ", "master of", "master's", "masters", "master")):
        return "Masters"
    if "associate" in s or "a.a." in s or "a.s." in s:
        return "Associates"
    if "doctor" in s or "phd" in s or "ph.d" in s:
        return "Doctorate"
    if "high school" in s:
        return "High School"
    if "ged" in s:
        return "GED"
    return None


def _extract_field_of_study(degree_str: str) -> str | None:
    """Extract the field of study from a degree string like
    'B.S. Informatics, Minor in Data Science' -> 'Informatics'."""
    s = (degree_str or "").strip()
    if not s:
        return None
    s = re.sub(r"^(B\.S\.|B\.A\.|M\.S\.|M\.A\.|Ph\.D\.|B\.E\.|B\.Tech\.|A\.S\.|A\.A\.)\s*", "", s, flags=re.IGNORECASE)
    s = re.sub(r",?\s*Minor in.*$", "", s, flags=re.IGNORECASE)
    s = s.strip(" ,")
    return s if s else None


def _extract_gpa(details: list[str]) -> str | None:
    """Extract a GPA value from education detail lines like
    'GPA: 3.75/4.00' -> '3.75'."""
    for line in details or []:
        m = re.search(r"GPA[:\s]+([0-9.]+)", line, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def _build_role_description(exp: dict) -> str:
    """Join experience bullet texts into a role description. Returns ''
    when there are no bullets: never fabricates."""
    bullets = exp.get("bullets") or []
    return "\n".join(b.get("text", "") for b in bullets if b.get("text")).strip()


def _entry_exists_in_text(body_text: str, *fragments: str) -> bool:
    """True when all normalized fragments appear in the normalized body
    text: used to detect that a work/education entry already exists on
    the My Experience page so we don't add a duplicate on a rerun. Returns
    False when no non-empty fragments are supplied (no signal to match)."""
    normalized_body = _normalize_text(body_text)
    checked = 0
    for fragment in fragments:
        if not fragment:
            continue
        if _normalize_text(fragment) not in normalized_body:
            return False
        checked += 1
    return checked > 0


def _resume_already_uploaded(page) -> bool:
    """Detect visible evidence that a resume has already been uploaded on
    the current page: Workday shows a 'resume.pdf successfully uploaded'
    confirmation or an uploaded-file chip after a successful attach. Used
    to make resume upload idempotent across continuation runs."""
    if _text_contains(page, ["successfully uploaded", "resume uploaded", "file uploaded"]):
        return True
    for selector in [
        "[data-automation-id*='uploaded' i]",
        "[data-automation-id*='file-name' i]",
    ]:
        if _has_visible(page, selector):
            return True
    return False


def _prior_resume_attached(state: dict) -> bool:
    """True if a prior checkpoint recorded a successful resume attach:
    the persisted-state side of resume idempotency. The dedicated
    ``state["resume_attached"]`` flag is the primary signal (it survives
    the capped ``fill_history[-10:]`` truncation); the fill_history scan
    is a backward-compatible fallback for checkpoints written before the
    flag existed. Safe when state is absent (returns False)."""
    if state.get("resume_attached"):
        return True
    for entry in state.get("fill_history") or []:
        if entry.get("resume_attached"):
            return True
    return False


def _is_my_experience_page(page) -> bool:
    """Detect the Workday 'My Experience' step: has add-buttons and both
    Work Experience and Education section headers."""
    if not _has_visible(page, "button[data-automation-id='add-button']"):
        return False
    return _text_contains_all(page, ["work experience", "education"])


def _normalize_month_for_input(month: str | None) -> str | None:
    """Normalize a parsed month value to what Workday's paired month/year
    inputs render. Workday's live inputs accept a numeric month string
    ('6') for June; a name ('June') is left as-is only when no numeric
    mapping is known. Returns None for an empty/unknown month: never
    fabricates a value."""
    if not month:
        return None
    s = str(month).strip()
    if not s:
        return None
    if s.isdigit():
        return s
    key = s.lower()
    if key in _MONTH_NAMES:
        return str(_MONTH_NAMES[key])
    return s


def _fill_date_inputs(page, start_month: str | None, start_year: str | None,
                       end_month: str | None, end_year: str | None,
                       is_current: bool) -> dict:
    """Fill Workday's paired month/year date inputs in order (start then
    end). Skips end-date inputs when the role is current. Returns a dict
    describing what was filled and what failed: never silently swallows a
    fill failure, since a missing date on a submitted application is
    irreversible and the caller must checkpoint as manual review when a
    required date could not be entered.

    Months are normalized to the numeric form Workday's inputs render
    (see _normalize_month_for_input); missing dates are never fabricated."""
    report: dict = {"filled": [], "failed": []}
    try:
        month_inputs = page.locator("input[data-automation-id='dateSectionMonth-input']")
        year_inputs = page.locator("input[data-automation-id='dateSectionYear-input']")
        month_count = month_inputs.count()
        year_count = year_inputs.count()
    except Exception as exc:
        report["failed"].append({"field": "date_inputs", "reason": f"could not locate date inputs: {exc}"})
        return report

    start_m = _normalize_month_for_input(start_month)
    if start_m:
        if month_count < 1:
            report["failed"].append({"field": "start_month", "value": start_m, "reason": "no start month input present"})
        else:
            try:
                month_inputs.nth(0).fill(start_m)
                report["filled"].append("start_month")
            except Exception as exc:
                report["failed"].append({"field": "start_month", "value": start_m, "reason": str(exc)})
    elif start_month is None and start_year:
        # A year-only range is valid; no month to fill.
        pass

    if start_year:
        if year_count < 1:
            report["failed"].append({"field": "start_year", "value": start_year, "reason": "no start year input present"})
        else:
            try:
                year_inputs.nth(0).fill(start_year)
                report["filled"].append("start_year")
            except Exception as exc:
                report["failed"].append({"field": "start_year", "value": start_year, "reason": str(exc)})

    if not is_current:
        end_m = _normalize_month_for_input(end_month)
        if end_m:
            if month_count < 2:
                report["failed"].append({"field": "end_month", "value": end_m, "reason": "no end month input present"})
            else:
                try:
                    month_inputs.nth(1).fill(end_m)
                    report["filled"].append("end_month")
                except Exception as exc:
                    report["failed"].append({"field": "end_month", "value": end_m, "reason": str(exc)})
        if end_year:
            if year_count < 2:
                report["failed"].append({"field": "end_year", "value": end_year, "reason": "no end year input present"})
            else:
                try:
                    year_inputs.nth(1).fill(end_year)
                    report["filled"].append("end_year")
                except Exception as exc:
                    report["failed"].append({"field": "end_year", "value": end_year, "reason": str(exc)})

    return report


def _fill_work_entry_fields(page, exp: dict, root=None) -> dict:
    """Fill one Work Experience entry form from a resume experience dict.

    Returns a dict with ``ok`` (bool), ``filled`` (list of field labels),
    and ``unresolved`` (list of {field, reason}) for fields that could not
    be truthfully filled. An entry is only reported as successfully added
    when its identity fields (jobTitle, companyName) were actually filled:
    a missing required control or an unfilled identity field produces an
    unresolved entry so the caller checkpoints as manual review rather than
    silently passing. Does NOT click Save/Submit; Workday's page Continue is
    the only non-final transition and is owned by the run() loop."""
    filled: list[str] = []
    unresolved: list[dict] = []
    title = exp.get("title", "")
    company = exp.get("company", "")
    location = exp.get("location", "")
    dates_str = exp.get("dates", "")
    is_current = "present" in (dates_str or "").lower()

    form = root or page
    # Identity fields first: a work entry without a title or company is
    # not a real entry and must not be reported as added.
    if title:
        if _fill_if_visible(form, "input[name='jobTitle']", title):
            filled.append("jobTitle")
        else:
            unresolved.append({"field": "jobTitle", "reason": "work title input not found or not fillable"})
    else:
        unresolved.append({"field": "jobTitle", "reason": "resume experience has no title"})
    if company:
        if _fill_if_visible(form, "input[name='companyName']", company):
            filled.append("companyName")
        else:
            unresolved.append({"field": "companyName", "reason": "company input not found or not fillable"})
    else:
        unresolved.append({"field": "companyName", "reason": "resume experience has no company"})
    if location:
        if _fill_if_visible(form, "input[name='location']", location):
            filled.append("location")

    # Toggle currentlyWorkHere BEFORE date handling for a current role so
    # Workday reveals/hides the end-date inputs consistently, then fill
    # start dates. Toggling after would risk clearing an already-entered
    # start date on some tenants. The start date is always filled first so
    # the toggle never loses it.
    start_m, start_y, end_m, end_y = _parse_resume_date_range(dates_str)
    date_report = _fill_date_inputs(form, start_m, start_y, end_m, end_y, is_current)
    filled.extend(f for f in date_report.get("filled", []))
    unresolved.extend(date_report.get("failed", []))

    if is_current:
        if _click_if_visible(form, "input[name='currentlyWorkHere']"):
            filled.append("currentlyWorkHere")
        else:
            # Not strictly unresolved: some tenants omit the toggle when
            # the role is current by default. Only flag when a date parse
            # also failed, since that is the actionable signal.
            pass

    desc = _build_role_description(exp)
    if desc:
        if _fill_if_visible(form, "textarea", desc):
            filled.append("description")

    identity_ok = "jobTitle" in filled and "companyName" in filled
    return {"ok": identity_ok and not unresolved, "filled": filled, "unresolved": unresolved}


def _fill_education_entry_fields(page, edu: dict, root=None) -> dict:
    """Fill one Education entry form from a resume education dict.

    Returns a dict with ``ok`` (bool), ``filled`` (list of field labels),
    and ``unresolved`` (list of {field, reason}). An entry is only reported
    as successfully added when the school identity field was filled AND any
    required degree dropdown was either filled with an exact option or had
    no degree string to map (a missing degree is not a failure). A degree
    string that maps to a Workday option but whose exact option is absent
    from the dropdown is an unresolved failure: never silently pass, since
    a wrong degree on a submitted application is irreversible. Does NOT
    click Save/Submit."""
    filled: list[str] = []
    unresolved: list[dict] = []
    school = edu.get("school", "")
    degree_str = edu.get("degree", "")
    details = edu.get("details") or []

    form = root or page
    if school:
        # Workday's real school field is its own custom "selectinput"
        # search-box widget, confirmed live against Capital One,
        # 2026-08-31: the input itself carries
        # data-uxi-widget-type="selectinput" and
        # data-automation-id="searchBox", with NO standard ARIA combobox
        # markers (no role="combobox", no aria-expanded/aria-haspopup):
        # fill_field's role/aria-based combobox detection can't recognize
        # it, so it falls through to a plain .fill(), which sets the
        # visible text but leaves Workday's internal selection state
        # unregistered; validation still reports the field empty.
        # Playwright's .fill() also does not reliably trigger this
        # widget's own live/debounced search at all (confirmed live: it
        # never opens a suggestion list): real keystrokes
        # (press_sequentially) are required to trigger the search, then
        # an exact-text suggestion match is clicked, same no-guessing
        # rule as try_combobox elsewhere: no exact match clears the field
        # rather than committing an unconfirmed guess. Scoped to the
        # field's container (its own element id and label `for` are
        # generated per-entry, e.g. "education-168--school", so not a
        # safe literal selector across entries/sessions; the
        # container's automation id is stable). Falls back to
        # fill_field's real-label match, then the raw legacy selectors,
        # for tenants without this exact widget: this remains a
        # genuinely hard field to resolve with full confidence on every
        # tenant; per policy, a case this can't fill correctly is
        # reported unresolved and routed to review with everything else
        # pre-filled, never guessed.
        school_filled = False
        try:
            search_input = form.locator("[data-automation-id='formField-school'] input[data-automation-id='searchBox']")
            if search_input.count() == 1:
                loc = search_input.first
                loc.click()
                loc.fill("")
                loc.press_sequentially(school, delay=60)
                target = school.strip().lower()
                deadline = time.monotonic() + 3.0
                while time.monotonic() < deadline and not school_filled:
                    for options in (page.get_by_role("option"), page.locator("[data-automation-id='promptOption']")):
                        try:
                            n = options.count()
                        except Exception:
                            n = 0
                        for i in range(n):
                            opt = options.nth(i)
                            try:
                                if not opt.is_visible():
                                    continue
                            except Exception:
                                pass
                            text = (opt.inner_text() or "").strip().lower()
                            if text == target:
                                opt.click()
                                school_filled = True
                                break
                        if school_filled:
                            break
                    if not school_filled:
                        time.sleep(0.25)
                if not school_filled:
                    try:
                        loc.fill("")
                    except Exception:
                        pass
        except Exception:
            school_filled = False
        if not school_filled:
            school_status, _ = fill_field(form, "School or University", school)
            school_filled = school_status == "filled"
        if not school_filled:
            school_filled = _fill_if_visible(form, "input[name='schoolName']", school)
        if not school_filled:
            school_filled = _fill_if_visible(form, "[data-automation-id='formField-school'] input", school)
        if school_filled:
            filled.append("schoolName")
        else:
            unresolved.append({"field": "schoolName", "reason": "school input not found or not fillable"})
    else:
        unresolved.append({"field": "schoolName", "reason": "resume education has no school"})

    degree_option = _map_degree_to_workday(degree_str)
    if degree_option:
        # A degree string that maps to a Workday option is a required
        # dropdown: an exact option must be selected, never a guess.
        if select_workday_listbox(form, 'button[name="degree"]', degree_option, option_page=page):
            filled.append("degree")
        else:
            unresolved.append({"field": "degree", "reason": f"exact degree option '{degree_option}' not found in dropdown"})
    elif degree_str:
        # A degree string that does not map to any Workday option is not
        # silently passed: flag it so the caller can checkpoint as manual
        # review rather than submitting an education entry with no degree.
        unresolved.append({"field": "degree", "reason": f"degree '{degree_str}' has no confident Workday mapping"})

    field_of_study = _extract_field_of_study(degree_str)
    if field_of_study:
        if _fill_if_visible(form, "input[name='fieldOfStudy']", field_of_study):
            filled.append("fieldOfStudy")

    gpa = _extract_gpa(details)
    if gpa:
        if _fill_if_visible(form, "input[name='gradeAverage']", gpa):
            filled.append("gradeAverage")

    # Some Workday tenants require a transcript upload on this entry (a
    # real, confirmed requirement, 2026-08-31; see docs/NEXT_STEPS.md).
    # aplyx never fabricates a document: attach the user's own uploaded
    # transcript (desktop app's Resume screen > Transcript) when one
    # exists, otherwise flag it as unresolved only if this specific page
    # actually has a transcript upload control: a page with no such
    # field must never be blocked on a document nobody was asked for.
    transcript_path = _local_transcript_path()
    if transcript_path:
        status, _ = attach_transcript(form, transcript_path)
        if status == "filled":
            filled.append("transcript")
    elif _has_transcript_upload_field(form):
        unresolved.append({
            "field": "transcript",
            "reason": "Workday requires a transcript upload but none is on file: add one from the app's Resume screen (Transcript section) and re-run",
        })

    identity_ok = "schoolName" in filled
    return {"ok": identity_ok and not unresolved, "filled": filled, "unresolved": unresolved}


def _has_transcript_upload_field(form) -> bool:
    try:
        file_inputs = form.locator("input[type=file]")
        n = file_inputs.count()
    except Exception:
        return False
    for i in range(n):
        try:
            context_text = file_inputs.nth(i).evaluate(
                "el => (el.closest('label,fieldset,form')?.innerText || '').toLowerCase()"
            )
        except Exception:
            context_text = ""
        if "transcript" in context_text:
            return True
    return False


def _fill_my_experience(page, resume_data: dict) -> dict:
    """Fill structured Work Experience and Education entries from the
    master resume. Idempotent: existing entries are detected by
    normalized company/title or school and not re-added. Languages are
    intentionally skipped (programming languages are not spoken
    languages). Returns a dict describing what was added, skipped, and
    left unresolved: an entry is only reported in work_added/
    education_added when its identity fields and required dropdowns were
    actually filled; a partially-filled or failed entry is reported in
    work_unresolved/education_unresolved so the caller checkpoints as
    manual review rather than silently passing."""
    result: dict[str, list] = {
        "work_added": [], "work_skipped": [], "work_unresolved": [],
        "education_added": [], "education_skipped": [], "education_unresolved": [],
    }
    if not resume_data or not _is_my_experience_page(page):
        return result
    try:
        body_text = page.locator("body").inner_text(timeout=1000) or ""
    except Exception:
        body_text = ""

    experiences = resume_data.get("experience") or []
    work_form_open = False
    for i, exp in enumerate(experiences):
        company = exp.get("company", "")
        title = exp.get("title", "")
        if company and title and _entry_exists_in_text(body_text, company, title):
            result["work_skipped"].append({"company": company, "title": title})
            continue
        if not work_form_open:
            try:
                buttons = page.locator("button[data-automation-id='add-button']")
                if buttons.count() < 1:
                    break
                buttons.nth(0).click(timeout=2000)
                _pause(500, 100)
                work_form_open = True
            except Exception:
                break
        else:
            _click_labeled(page, ["Add Another", "Add another"], roles=("button",))
            _pause(500, 100)
        work_panels = page.locator(
            "[role='group'][aria-labelledby^='Work-Experience-'][aria-labelledby$='-panel']"
        )
        work_panel = work_panels.last if work_panels.count() else None
        entry_report = _fill_work_entry_fields(page, exp, work_panel)
        if entry_report["ok"]:
            result["work_added"].append({"company": company, "title": title})
        else:
            result["work_unresolved"].append({
                "company": company, "title": title,
                "filled": entry_report["filled"],
                "unresolved": entry_report["unresolved"],
            })
        try:
            body_text = page.locator("body").inner_text(timeout=1000) or ""
        except Exception:
            pass

    educations = resume_data.get("education") or []
    edu_form_open = False
    for i, edu in enumerate(educations):
        school = edu.get("school", "")
        degree_str = edu.get("degree", "")
        if school and _entry_exists_in_text(body_text, school):
            result["education_skipped"].append({"school": school, "degree": degree_str})
            continue
        if not edu_form_open:
            try:
                buttons = page.locator("button[data-automation-id='add-button']")
                if buttons.count() < 2:
                    break
                buttons.nth(1).click(timeout=2000)
                _pause(500, 100)
                edu_form_open = True
            except Exception:
                break
        else:
            _click_labeled(page, ["Add Another", "Add another"], roles=("button",))
            _pause(500, 100)
        education_panels = page.locator(
            "[role='group'][aria-labelledby^='Education-'][aria-labelledby$='-panel']"
        )
        education_panel = education_panels.last if education_panels.count() else None
        entry_report = _fill_education_entry_fields(page, edu, education_panel)
        if entry_report["ok"]:
            result["education_added"].append({"school": school, "degree": degree_str})
        else:
            result["education_unresolved"].append({
                "school": school, "degree": degree_str,
                "filled": entry_report["filled"],
                "unresolved": entry_report["unresolved"],
            })
        try:
            body_text = page.locator("body").inner_text(timeout=1000) or ""
        except Exception:
            pass

    return result


# --- Inferred required-question answers ----------------------------------


def _company_in_resume_experience(company: str, resume_data: dict) -> bool:
    """True when *company* (normalized) matches any experience company in
    the master resume: used to answer 'Have you ever worked at <company>?'
    with Yes only when the employer is actually present."""
    target = _normalize_text(company)
    if not target:
        return False
    for exp in resume_data.get("experience") or []:
        if target and target in _normalize_text(exp.get("company", "")):
            return True
        if target and target in _normalize_text(exp.get("title", "")):
            return True
    return False


def _extract_company_from_worked_question(question_text: str) -> tuple[str | None, bool]:
    """Extract the company name from a 'Have you ever worked at <company>
    or affiliates?' question label. Returns (company, is_broad_affiliates)
    where is_broad_affiliates is True for the broad 'or affiliates' /
    'or any of its affiliates' wording (which covers a family of
    companies, not just the named one) and False for a narrow
    previous-employer phrasing. Returns (None, False) if the pattern
    doesn't match: never guesses."""
    m = re.search(r"worked (?:at|for)\s+(.+?)\s+or (?:its )?affiliates?", question_text, re.IGNORECASE)
    if m:
        return m.group(1).strip(), True
    m = re.search(r"worked (?:at|for)\s+(.+?)\s+or any of", question_text, re.IGNORECASE)
    if m:
        return m.group(1).strip(), True
    # Narrow previous-employer phrasing with no affiliates clause.
    m = re.search(r"have you (?:ever )?worked (?:at|for)\s+(.+?)\??$", question_text, re.IGNORECASE)
    if m:
        return m.group(1).strip().rstrip("?"), False
    return None, False


def _infer_worked_at_company_answer(question_text: str, resume_data: dict) -> str | None:
    """Determine the answer to 'Have you ever worked at <company> or
    affiliates?': Yes only when the company is in the resume experience.
    For the broad affiliates wording, return None (unresolved) when the
    company is absent rather than asserting No: 'or affiliates' covers a
    family of companies the resume may not name explicitly, so a No could
    be false. For a narrow previous-employer phrasing (no affiliates
    clause), No is safe only when the company is clearly absent."""
    company, is_broad = _extract_company_from_worked_question(question_text)
    if not company:
        return None
    present = _company_in_resume_experience(company, resume_data)
    if present:
        return "Yes"
    # Absent: broad affiliates wording is unresolved (the affiliate family
    # may include an employer the resume names differently); a narrow
    # previous-employer phrasing may safely answer No.
    if is_broad:
        return None
    return "No"


def _location_matches_preferred(job_location: str, preferred_locations: list[str]) -> bool:
    """True when *job_location* (normalized) contains or is contained by
    any preferred location (normalized): a bidirectional substring match
    so 'Seattle, WA' matches 'Seattle' and vice versa."""
    target = _normalize_text(job_location)
    if not target:
        return False
    for pref in preferred_locations or []:
        pref_norm = _normalize_text(pref)
        if not pref_norm:
            continue
        if pref_norm in target or target in pref_norm:
            return True
    return False


def _infer_relocation_answer(question_text: str, job_location: str | None, preferred_locations: list[str]) -> str | None:
    """Determine the answer to a relocation willingness question: Yes
    only when the job location matches a configured preferred location.
    Returns None (unresolved) when the job location is unknown or doesn't
    match: never guesses Yes or No."""
    if not job_location:
        return None
    return "Yes" if _location_matches_preferred(job_location, preferred_locations) else None


def _fill_question_control(page, question_label: str, answer: str) -> bool:
    """Fill a question control when Workday's accessible label is broader
    than the text captured by the question regex. Workday keeps the control
    inside the nearest ancestor containing a button/select, while the opened
    option menu may be portaled under document.body."""
    try:
        labels = page.get_by_text(question_label, exact=False)
        candidates = [labels.nth(i) for i in range(labels.count())]
        # Some Workday prompts split the visible question across nested spans,
        # so get_by_text does not return the label node. Search the explicit
        # label-like containers as a fallback without relying on control order.
        label_nodes = page.locator("label, legend, [data-automation-id*='label' i]")
        for i in range(label_nodes.count()):
            node = label_nodes.nth(i)
            if question_label.strip().lower() in (node.inner_text(timeout=500) or "").strip().lower():
                candidates.append(node)
        for label in candidates:
            wrapper = label.locator("xpath=ancestor::*[.//button or .//select][1]")
            controls = wrapper.locator("button, select")
            if controls.count() < 1:
                controls = label.locator("xpath=following::button[1]")
                if controls.count() < 1:
                    continue
            control = controls.first
            tag = (control.evaluate("el => el.tagName") or "").lower()
            if tag == "select":
                options = control.locator("option")
                target = answer.strip().lower()
                if not any((options.nth(j).inner_text() or "").strip().lower() == target for j in range(options.count())):
                    continue
                control.select_option(label=answer)
                return True
            if try_combobox(page, control, answer):
                return True
    except Exception:
        pass
    return False


def _is_ai_attestation_question(question_text: str) -> bool:
    """Detect the Expedia AI-attestation / material acknowledgment
    question so it is NEVER auto-answered: the applicant must attest
    personally."""
    lower = (question_text or "").lower()
    if "attest" in lower or "acknowledg" in lower:
        if "ai" in lower or "artificial intelligence" in lower:
            return True
    return False


def _fill_inferred_questions(page, resume_data: dict, job_location: str | None,
                             preferred_locations: list[str]) -> list[dict]:
    """Detect and fill inferred required yes/no questions on the current
    step using conservative, evidence-based answers. Returns a list of
    unresolved questions (those aplyx cannot safely answer): the caller
    checkpoints as manual review when this list is non-empty.

    AI-attestation detection runs even when resume_data is empty/corrupt,
    since that question must never be auto-answered regardless of resume
    state. Regexes are newline-safe (re.DOTALL) and bounded to a single
    question so a multi-question page does not conflate them."""
    unresolved: list[dict] = []
    try:
        body_text = page.locator("body").inner_text(timeout=1000) or ""
    except Exception:
        return unresolved

    # "Have you ever worked at <company> or affiliates?": bounded to one
    # question via a non-greedy match that stops at the first '?'. re.DOTALL
    # so a question wrapped across lines is still matched as one unit. Uses
    # \s+ (not literal spaces) so a newline between words still matches.
    worked_match = re.search(
        r"have you ever worked\s+(?:at|for)\s+.+?(?:or\s+(?:its\s+)?affiliates?\??)",
        body_text, re.IGNORECASE | re.DOTALL,
    )
    if worked_match:
        question_label = worked_match.group(0)
        if _is_ai_attestation_question(question_label):
            unresolved.append({"question": question_label, "reason": "AI attestation / material acknowledgment: not auto-answered"})
        else:
            answer = _infer_worked_at_company_answer(question_label, resume_data or {})
            if answer is None:
                # _infer_worked_at_company_answer returns None only when the
                # company couldn't be extracted, or when it was extracted but
                # the broad "or affiliates" wording left it unresolved (a
                # narrow previous-employer phrasing always resolves to a
                # definite Yes/No, never None): re-extracting here can only
                # land in one of those two cases.
                company, _is_broad = _extract_company_from_worked_question(question_label)
                if not company:
                    reason = "could not extract company name from the question"
                else:
                    reason = f"company '{company}' is not in resume experience and the broad 'or affiliates' wording is unresolved (an affiliate may be named differently in the resume)"
                unresolved.append({"question": question_label, "reason": reason})
            else:
                status, _ = fill_field(page, question_label, answer)
                if status != "filled" and not _fill_question_control(page, question_label, answer):
                    unresolved.append({"question": question_label, "reason": f"inferred '{answer}' but the field could not be filled"})

    # Relocation willingness: bounded to one sentence/question.
    relocate_match = re.search(
        r"(?:are you|would you|will you|do you)[^.]*?relocat[^.]*?\?",
        body_text, re.IGNORECASE | re.DOTALL,
    )
    if relocate_match:
        question_label = relocate_match.group(0)
        answer = _infer_relocation_answer(question_label, job_location, preferred_locations)
        if answer is not None:
            status, _ = fill_field(page, question_label, answer)
            if status != "filled" and not _fill_question_control(page, question_label, answer):
                unresolved.append({"question": question_label, "reason": f"inferred '{answer}' but the field could not be filled"})
        else:
            reason = "job location unknown" if not job_location else f"job location '{job_location}' does not match a configured preferred location"
            unresolved.append({"question": question_label, "reason": reason})

    # AI attestation (standalone, not part of the worked-at pattern).
    # Match in either order: "attest ... AI" or "AI ... attest", since
    # the live Expedia question phrases it as "Do you attest ... not use AI".
    # Bounded to one question; runs even when resume_data is empty.
    if not worked_match or not _is_ai_attestation_question(worked_match.group(0)):
        attest_match = re.search(
            r"(?:(?:ai|artificial intelligence)[^.]*?(?:attest|acknowledg|certif)|(?:attest|acknowledg|certif)[^.]*?(?:ai|artificial intelligence))[^.]*?\?",
            body_text, re.IGNORECASE | re.DOTALL,
        )
        if attest_match:
            unresolved.append({"question": attest_match.group(0), "reason": "AI attestation / material acknowledgment: not auto-answered"})

    return unresolved


def _fill_workday_page(page, safe_fields: dict[str, str], resume_pdf: str | None = None, cover_letter: str | None = None, *, skip_resume: bool = False, resume_data: dict | None = None, job_location: str | None = None, preferred_locations: list[str] | None = None) -> dict:
    filled: list[str] = []
    unmatched: list[str] = []
    conservative_defaults: list[dict[str, str]] = []
    values = dict(safe_fields)
    constructed_usernames: set[str] = set()
    for username_key, url_key, prefix in (
        ("linkedin_username", "linkedin_url", "https://linkedin.com/in/"),
        ("github_username", "github_url", "https://github.com/"),
    ):
        username = values.get(username_key, "").strip()
        if username and not values.get(url_key, "").strip():
            values[url_key] = f"{prefix.replace('://', '://www.', 1)}{quote(username, safe='')}"
            constructed_usernames.add(username_key)
    # The profile stores city+state as one combined "location" value
    # ("Maple Valley, WA") with no separate state field: derive one when
    # a Workday page asks for State/Province as its own control. Only
    # a trailing 2-letter code is trusted (a real, unambiguous value
    # already implied by the profile, not a guess); anything else is left
    # for the field to surface as unmatched rather than guessed (real gap
    # found live against Capital One's "My Information" step, 2026-08-31).
    if not values.get("state", "").strip():
        loc_parts = [p.strip() for p in values.get("location", "").rsplit(",", 1)]
        if len(loc_parts) == 2 and re.fullmatch(r"[A-Za-z]{2}", loc_parts[1]):
            values["state"] = US_STATE_ABBR_TO_NAME.get(loc_parts[1].upper(), loc_parts[1].upper())
    for key, labels in SAFE_FIELD_LABELS.items():
        value = _normalize_profile_url(key, values.get(key, ""))
        if not value:
            continue
        matched = False
        for label in labels:
            status, note = fill_field(page, label, value)
            if status == "filled":
                filled.append(label)
                matched = True
                _pause(220, 60)
                break
            if status == "skipped":
                matched = True
                break
        if not matched and key in WORKDAY_STANDARD_LISTBOX_SELECTORS:
            if select_workday_listbox(page, WORKDAY_STANDARD_LISTBOX_SELECTORS[key], value):
                filled.append(key)
                matched = True
                _pause(220, 60)
        if not matched and key not in constructed_usernames:
            unmatched.append(key)

    for label, value_candidates, note in CONSERVATIVE_DEFAULTS:
        candidates = value_candidates if isinstance(value_candidates, (list, tuple)) else (value_candidates,)
        status = "unmatched"
        value = candidates[0]
        for candidate in candidates:
            status, _ = fill_field(page, label, candidate)
            if status != "filled" and label in WORKDAY_STANDARD_LISTBOX_SELECTORS:
                if select_workday_listbox(page, WORKDAY_STANDARD_LISTBOX_SELECTORS[label], candidate):
                    status = "filled"
            if status == "filled":
                value = candidate
                break
        if status == "filled":
            filled.append(label)
            conservative_defaults.append({"field_name": label, "filled_value": value, "source": "conservative_default", "note": note})
            _pause(220, 60)
        elif status == "unmatched":
            unmatched.append(label)

    resume_path = _resume_pdf_path(resume_pdf)
    resume_attached = False
    resume_skipped = False
    if skip_resume:
        # Idempotent resume upload: a prior checkpoint or visible
        # uploaded-file evidence shows the resume is already attached.
        # Do NOT call attach_resume again: repeated runs were producing
        # duplicate 'resume.pdf successfully uploaded' entries on the
        # live Expedia page. Report resume_attached=True so the
        # checkpoint and emit reflect the actual state.
        resume_skipped = True
        resume_attached = True
    elif resume_path:
        try:
            file_inputs = page.locator("input[type=file]")
            if file_inputs.count() > 0:
                status, _ = attach_resume(page, resume_path)
                resume_attached = status == "filled"
                if resume_attached:
                    _pause(2400, 500)
        except Exception:
            resume_attached = False

    cover_letter_pasted = False
    if cover_letter:
        try:
            cover_letter_pasted = _paste_cover_letter(page, cover_letter)
            if cover_letter_pasted:
                _pause(220, 60)
        except Exception:
            cover_letter_pasted = False

    my_experience: dict[str, list] = {"work_added": [], "work_skipped": [], "work_unresolved": [], "education_added": [], "education_skipped": [], "education_unresolved": []}
    experience_error: str | None = None
    if resume_data:
        # Do NOT swallow exceptions here: a failure in structured fill must
        # surface as an unresolved sentinel so the runtime cannot proceed
        # toward submit while a required entry was only partially filled.
        try:
            my_experience = _fill_my_experience(page, resume_data)
        except Exception as exc:
            experience_error = str(exc)
            my_experience["work_unresolved"] = my_experience.get("work_unresolved", []) + [{"field": "_fill_my_experience", "reason": f"structured fill raised: {exc}"}]

    # AI-attestation / inferred-question detection runs even when resume_data
    # is empty/corrupt: that question must never be auto-answered regardless
    # of resume state. A failure here must also produce an unresolved
    # sentinel, never a silent pass that lets the runtime proceed to submit
    # while a safety check was unavailable.
    unresolved_questions: list[dict] = []
    try:
        unresolved_questions = _fill_inferred_questions(page, resume_data or {}, job_location, preferred_locations)
    except Exception as exc:
        unresolved_questions = [{"question": "_fill_inferred_questions", "reason": f"inferred-question detection raised: {exc}"}]

    # Structured-fill unresolved entries are safety sentinels too: surface
    # them as unresolved_questions so the run() loop checkpoints as manual
    # review and never proceeds toward submit with a partially-filled entry.
    for entry in (my_experience.get("work_unresolved") or []):
        unresolved_questions.append({"question": f"work experience entry: {entry.get('company', '?')} / {entry.get('title', '?')}", "reason": "; ".join(f"{u.get('field')}: {u.get('reason')}" for u in entry.get("unresolved", [])) or "partially filled"})
    for entry in (my_experience.get("education_unresolved") or []):
        unresolved_questions.append({"question": f"education entry: {entry.get('school', '?')}", "reason": "; ".join(f"{u.get('field')}: {u.get('reason')}" for u in entry.get("unresolved", [])) or "partially filled"})
    if experience_error:
        unresolved_questions.append({"question": "_fill_my_experience", "reason": experience_error})

    return {
        "filled_labels": filled,
        "unmatched_keys": unmatched,
        "resume_attached": resume_attached,
        "resume_skipped": resume_skipped,
        "cover_letter_pasted": cover_letter_pasted,
        "conservative_defaults": conservative_defaults,
        "my_experience": my_experience,
        "unresolved_questions": unresolved_questions,
        "step_title": _workday_step_title(page),
        "url": page.url,
    }


def _page_signature(page) -> str:
    return page_signature(page, _workday_step_title(page))


def _ensure_apply_flow(page) -> None:
    """Workday posting URLs often land on a public posting page first, with
    an Apply button that opens the actual account/application flow. Do that
    transition explicitly before account-mode detection, otherwise the public
    posting's Apply button can be mistaken for a final submit button later.
    Best-effort and fail-closed: if no apply-entry control is visible, leave
    the page alone and let the normal unknown-state checkpoint path fire."""
    if _account_mode(page) != "unknown" or _otp_mode(page):
        return
    if _application_start_modal(page):
        if _prefer_resume_start(page):
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                _pause(400, 100)
                if _sign_in_choice_page(page) or _account_mode(page) != "unknown" or _otp_mode(page):
                    return
            if _switch_to_apply_manually_url(page):
                return
        if _fallback_manual_start(page):
            _pause(1400, 260)
            return
    button = _apply_entry_button(page)
    # Workday renders the posting body and Apply control after the initial
    # DOMContentLoaded event. Do not checkpoint the public posting merely
    # because that client-side render took longer than the normal pause.
    deadline = time.monotonic() + 30.0
    while button is None and time.monotonic() < deadline:
        _pause(450, 0)
        button = _apply_entry_button(page)
    if button is None:
        return
    try:
        button.click(timeout=2000)
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            _pause(450, 0)
            if _application_start_modal(page) or _sign_in_choice_page(page) or _account_mode(page) != "unknown" or _otp_mode(page):
                break
        if _application_start_modal(page):
            if _prefer_resume_start(page):
                deadline = time.monotonic() + 5.0
                while time.monotonic() < deadline:
                    _pause(400, 100)
                    if _sign_in_choice_page(page) or _account_mode(page) != "unknown" or _otp_mode(page):
                        return
                if _switch_to_apply_manually_url(page):
                    return
            if _fallback_manual_start(page):
                _pause(1400, 260)
                return
    except Exception:
        return


def run(job_id: str, review_queue_path: str, state_dir: str, alias_email: str, alias_id: str | None = None, no_submit: bool = False, user_data_dir: str | None = None, apply_url: str | None = None, resume_pdf: str | None = None, cover_letter: str | None = None, account_email: str | None = None, session_secret_file: str | None = None, job_location: str | None = None, credential_file: str | None = None) -> int:
    entry = _apply_entry(job_id, review_queue_path, apply_url)
    apply_url = entry.get("apply_url") or entry.get("url")
    if not apply_url:
        return _write_result(False, f"job_id={job_id!r} has no apply_url or url")
    if not _looks_like_workday(str(apply_url)):
        return _write_result(False, "approve-submit scaffolding is only implemented for Workday entries right now")
    # A personal candidate email (from a connected/verified Gmail profile
    # or verification session) is preferred when supplied; the managed
    # mail.aplyx.app alias remains a supported compatibility path. Do NOT
    # silently fall back to a personal email that was never authenticated:
    # exactly one of account_email or alias_email must be present, and
    # the caller is responsible for only passing account_email when it
    # came from a verified source. The effective email is what gets filled
    # into the account form and keys the password sidecar.
    effective_email = _normalize_account_email(account_email) or _normalize_account_email(alias_email)
    if not effective_email:
        return _write_result(False, "Workday account setup needs a verified candidate email or a managed mail.aplyx.app alias before it can continue")
    # The session-secret file is the only supported handoff path for a
    # one-time verification link/OTP; raw credentials never enter argv.
    file_link, file_otp = _read_session_secret_file(session_secret_file)
    verification_link = file_link
    verification_otp = file_otp
    if session_secret_file and session_secret_file != "-":
        try:
            os.unlink(session_secret_file)
        except FileNotFoundError:
            pass
        except OSError:
            pass

    state = _load_state(state_dir, job_id)
    # Key the password sidecar by account identity (effective email +
    # tenant host), not job_id, so jobs sharing one Workday account reuse
    # the same generated credentials instead of re-creating a new account
    # on every login retry. Normalized so case variants reuse one sidecar.
    account_key = _account_key(effective_email, str(apply_url))
    credential_password, credential_error = _read_credential_file(credential_file)
    if credential_file and credential_error:
        return _write_result(False, f"could not use the app's Workday credential: {credential_error}")
    password = credential_password or _load_local_password(state_dir, account_key) or _random_password()
    # _save_local_password now raises on I/O failure rather than silently
    # swallowing it: a swallowed write would let the runtime proceed with
    # a password that was never durably recorded, so a later continuation
    # would regenerate a fresh credential and re-create the account. Fail
    # closed here with a checkpoint-safe result instead.
    if credential_password is None:
        try:
            _save_local_password(state_dir, account_key, password)
        except OSError as exc:
            return _write_result(False, f"could not persist the Workday account password sidecar: {exc}. Aborting before account creation so a later run does not regenerate credentials. Resolve the I/O issue and re-run.")
    state.update({
        "job_id": job_id,
        "apply_url": str(apply_url),
        "account_email": effective_email,
        # alias_email/alias_id retained for backward-compatible audit;
        # effective_email is the value actually filled into the form.
        "alias_email": _normalize_account_email(alias_email) or None,
        "alias_id": alias_id,
        "status": str(state.get("status") or "initialized"),
    })
    safe_fields = _read_safe_fields()
    resume_data = _load_master_resume()
    preferred_locations = _read_preferred_locations()
    # A fresh --apply-url run carries no queue entry, so the canonical job
    # location is supplied via --job-location. Queue continuations still
    # read location from the queue entry (entry.location / entry.job_location);
    # the explicit arg only wins when the queue entry has none.
    job_location = job_location or entry.get("location") or entry.get("job_location")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return _write_result(False, "the 'playwright' pip package is not installed: run `pip3 install -r requirements.txt` first")

    with sync_playwright() as p:
        try:
            context = p.chromium.launch_persistent_context(
                user_data_dir or default_chrome_user_data_dir(),
                channel="chrome",
                headless=False,
                args=["--no-first-run"],
            )
        except Exception as exc:
            if is_profile_lock_error(exc):
                return _write_result(False, "your default Chrome is already running with this profile: close Chrome and try again")
            return _write_result(False, f"could not launch Chrome: {exc}")

        page = context.pages[0] if context.pages else context.new_page()
        # Set True only at the one checkpoint where a human is expected
        # to pick up immediately in this same window (an unmapped
        # required field): every other checkpoint/outcome keeps the
        # existing always-close behavior, so this doesn't change what
        # the existing test suite already covers.
        keep_browser_open = False
        try:
            start_url = str(apply_url)
            if state.get("status") not in {None, "", "initialized"}:
                start_url = _workday_login_url(start_url)
            page.goto(start_url, wait_until="domcontentloaded")
            _pause(1200, 240)
            _ensure_apply_flow(page)

            challenge = detect_challenge(page)
            if challenge:
                state["status"] = "challenge_detected"
                return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a challenge ({challenge}) before account setup could proceed. Checkpoint saved. Resolve manually and re-run.", outcome="checkpoint")

            # An MFA/SSO/security-key/push page that aplyx cannot safely
            # automate stops here as manual_required: never guessed, never
            # claimed verified. This runs before OTP/link consumption so a
            # TOTP/push challenge is caught even when a code was supplied.
            manual = _manual_required_reason(page)
            if manual:
                state["status"] = "manual_required"
                state["manual_required_reason"] = manual
                return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a {manual} challenge that aplyx cannot safely automate. Checkpoint saved. Complete this step manually and re-run.", outcome="checkpoint", manual_required=manual)

            if verification_link:
                page.goto(verification_link, wait_until="domcontentloaded")
                _pause(1200, 240)
                # A verification link is a single-use credential just like
                # an OTP. Keep only a digest in the checkpoint; the raw link
                # must never survive this process in local state.
                state["last_verification_link_hash"] = hashlib.sha256(verification_link.encode("utf-8")).hexdigest()
                if _text_contains(page, ["verified", "activated", "confirmed", "successfully"]):
                    state["status"] = "verified"
                    state["used_verification_link"] = True
                    # The verification clearly succeeded. Instead of
                    # forcing a re-run, navigate back to the apply URL
                    # and let the account-mode detection below drive the
                    # next step (login, or straight into page-fill) when
                    # the page is clearly past verification. If the page
                    # ends up in an unknown state, the normal fail-closed
                    # checkpoint path below handles it.
                    page.goto(str(apply_url), wait_until="domcontentloaded")
                    _pause(1200, 240)
                    _ensure_apply_flow(page)

            if verification_otp and _otp_mode(page):
                if _fill_first_visible(page, [
                    "input[name*='code' i]",
                    "input[id*='code' i]",
                    "input[data-automation-id*='code' i]",
                    "input[name*='otp' i]",
                    "input[id*='otp' i]",
                    "input[data-automation-id*='otp' i]",
                ], verification_otp):
                    _pause(220, 60)
                    if _click_if_visible(page, "[data-automation-id='submitButton']"):
                        _pause(1400, 260)
                    # Never persist the OTP itself: a one-way hash is
                    # enough for an audit trail (this value is never
                    # read back for a reuse decision anywhere in this
                    # file) without keeping a live verification code
                    # sitting in a checkpoint file on disk.
                    state["last_verification_otp_hash"] = hashlib.sha256(verification_otp.encode("utf-8")).hexdigest()
                    # Guard: if the page is still asking for a code, the
                    # OTP did not take (wrong/expired code, or a
                    # validation error). Checkpoint and stop rather than
                    # guessing: never proceed into page-fill on a page
                    # that is still the verification step.
                    if _otp_mode(page):
                        state["status"] = "awaiting_verification"
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday verification code was entered but the page is still asking for a code. Checkpoint saved. Re-run with a fresh OTP.", outcome="checkpoint")
                    # OTP clearly cleared verification. Continue into
                    # login/page-fill below instead of forcing a re-run.
                    state["used_verification_otp"] = True
                    state["status"] = "verified"

            if _sign_in_choice_page(page):
                if not _click_labeled(page, ["Sign in with email"], roles=("button",)):
                    state["status"] = "sign_in_choice_unrecognized"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday sign-in choice page was reached, but the email sign-in option could not be activated.")
                _pause(1400, 260)
                if _choose_create_account(page):
                    _pause(1400, 260)
                else:
                    # NVIDIA's autofill path can land on a sign-in wall with no
                    # visible create-account link, while the sibling manual path
                    # does expose one. Fall back explicitly to the manual path,
                    # then retry the email -> create-account branch once.
                    if _switch_to_apply_manually_url(page) and _sign_in_choice_page(page):
                        if _click_labeled(page, ["Sign in with email"], roles=("button",)):
                            _pause(1400, 260)
                        if _choose_create_account(page):
                            _pause(1400, 260)
                    if not _account_mode(page) == "create_account":
                        state["status"] = "create_account_path_missing"
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Reached the Workday sign-in-with-email flow, but no create-account path was visible. Checkpoint saved for manual follow-up.")

            _wait_for_account_mode_settled(page)
            mode = _account_mode(page)
            if mode == "create_account":
                challenge = detect_challenge(page)
                if challenge:
                    state["status"] = "challenge_detected"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a challenge ({challenge}) on the create-account page. Checkpoint saved. Resolve manually and re-run.", outcome="checkpoint")
                _fill_account_credentials(page, effective_email, password, include_confirmation=True)
                _pause(220, 60)
                _click_if_visible(page, "[data-automation-id='createAccountCheckbox']")
                _pause(220, 60)
                if not _submit_create_account(page):
                    state["status"] = "account_form_unrecognized"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday account form was found but the submit button could not be activated.")
                _pause(1800, 300)
                # Never claim the account was created solely because the
                # Create Account button was clicked: Workday can reject the
                # submission with inline validation errors (duplicate email,
                # weak password, required checkbox unchecked) without
                # navigating away. Verify the create form is actually gone
                # and no validation errors remain before checkpointing as
                # awaiting_verification; otherwise report a truthful failure.
                create_mode = _account_mode(page)
                errors = _validation_errors(page)
                if create_mode == "create_account" or errors:
                    note = (" Validation: " + "; ".join(errors[:3])) if errors else ""
                    state["status"] = "create_account_failed"
                    problem = "the form is still present" if create_mode == "create_account" else "the page showed validation errors"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday Create Account was clicked but {problem}.{note} Checkpoint saved. Check the browser and re-run.", outcome="failed")
                if _verification_required(page):
                    state["status"] = "awaiting_verification"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, True, "Workday account created. Waiting for an email verification link or OTP before continuing.", outcome="checkpoint")
                # Some Workday tenants authenticate the newly-created account
                # immediately and open the application without an email
                # challenge. Continue into the normal fill loop in that case.
                state["status"] = "logged_in"
                mode = _account_mode(page)

            if mode == "login":
                challenge = detect_challenge(page)
                if challenge:
                    state["status"] = "challenge_detected"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a challenge ({challenge}) on the login page. Checkpoint saved. Resolve manually and re-run.", outcome="checkpoint")
                _fill_account_credentials(page, effective_email, password)
                _pause(220, 60)
                if not _submit_login(page):
                    state["status"] = "login_form_unrecognized"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday login form was found but the submit button could not be activated.")
                _pause(1600, 300)
                # Do not assume success just because submit was
                # clicked: if the login form is still on screen, the
                # credentials were rejected or a validation error
                # surfaced. Checkpoint and stop rather than proceeding
                # into page-fill on a page that was never logged in to.
                if _still_on_login_page(page):
                    errors = _validation_errors(page)
                    note = (" Validation: " + "; ".join(errors[:3])) if errors else ""
                    # An account that exists but was never verified (e.g.
                    # an earlier run created it but stopped before OTP/link
                    # retrieval completed) rejects login with a "verify
                    # your account" error and a Resend Account Verification
                    # link, not a generic credential failure. Treat this as
                    # awaiting_verification (a continuation with a fresh
                    # OTP/link can complete it), not a dead-end
                    # login_failed: same distinction the create_account
                    # branch already makes above (real gap found live
                    # against Capital One, 2026-08-31).
                    unverified = any("verif" in e.lower() for e in errors)
                    if unverified and _click_labeled(page, ["Resend Account Verification", "Resend account verification"], roles=("link", "button")):
                        state["status"] = "awaiting_verification"
                        return _emit_with_checkpoint(page, state_dir, job_id, state, True, f"Workday account exists but is unverified; requested a new verification email.{note} Re-run with the verification link or OTP after it arrives.", outcome="checkpoint")
                    state["status"] = "login_failed"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday login submit was clicked but the page is still on the login screen.{note} Checkpoint saved for retry.", outcome="failed")
                state["status"] = "logged_in"

            if state.get("status") == "awaiting_verification":
                if _verification_required(page):
                    return _emit_with_checkpoint(
                        page,
                        state_dir,
                        job_id,
                        state,
                        False,
                        "Workday is still waiting on account verification. Re-run with the verification link or OTP after it arrives.",
                        outcome="checkpoint",
                    )
                state["status"] = "logged_in"

            if state.get("status") in {"logged_in", "verified", "page_filled", "page_advanced", "ready_to_submit"} or mode == "unknown":
                # seen_signatures is invocation-scoped: a ready_to_submit
                # (or any other) continuation must not abort on signatures
                # persisted by a previous run, since the page it resumes on
                # is by definition one it has seen before. Start fresh each
                # invocation so loop detection only fires within this one
                # call's page-advance loop, not across continuation
                # boundaries. The persisted list is still written for audit.
                seen_signatures: set[str] = set()
                final_result = None
                for _ in range(5):
                    signature = _page_signature(page)
                    if signature in seen_signatures:
                        state["status"] = "page_filled"
                        state["seen_signatures"] = list(seen_signatures)
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday page looped back to a previously-seen step. Checkpoint saved for manual follow-up.")
                    seen_signatures.add(signature)

                    if _sign_in_choice_page(page):
                        if not _click_labeled(page, ["Sign in with email"], roles=("button",)):
                            state["status"] = "sign_in_choice_unrecognized"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday sign-in choice page was reached during continuation, but the email sign-in option could not be activated.")
                        _pause(1400, 260)
                        if _choose_create_account(page):
                            _pause(1400, 260)
                            mode = _account_mode(page)
                            if mode == "create_account":
                                _fill_account_credentials(page, effective_email, password, include_confirmation=True)
                                _pause(220, 60)
                                _click_if_visible(page, "[data-automation-id='createAccountCheckbox']")
                                _pause(220, 60)
                                if not _submit_create_account(page):
                                    state["status"] = "account_form_unrecognized"
                                    state["seen_signatures"] = list(seen_signatures)
                                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday account form was reached during continuation, but the Create Account button could not be activated.")
                                _pause(1800, 300)
                                create_mode = _account_mode(page)
                                errors = _validation_errors(page)
                                if create_mode == "create_account" or errors:
                                    note = (" Validation: " + "; ".join(errors[:3])) if errors else ""
                                    state["status"] = "create_account_failed"
                                    state["seen_signatures"] = list(seen_signatures)
                                    problem = "the form is still present" if create_mode == "create_account" else "the page showed validation errors"
                                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday Create Account was clicked during continuation but {problem}.{note} Checkpoint saved. Check the browser and re-run.", outcome="failed")
                                if _verification_required(page):
                                    state["status"] = "awaiting_verification"
                                    state["seen_signatures"] = list(seen_signatures)
                                    return _emit_with_checkpoint(page, state_dir, job_id, state, True, "Workday account created during continuation. Waiting for an email verification link or OTP before continuing.", outcome="checkpoint")
                                state["status"] = "logged_in"
                                mode = _account_mode(page)
                                continue
                        state["status"] = "create_account_path_missing"
                        state["seen_signatures"] = list(seen_signatures)
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday sign-in choice page was reached during continuation, but no create-account path was visible.")

                    _wait_for_application_control(page)
                    skip_resume = _prior_resume_attached(state) or _resume_already_uploaded(page)
                    fill_result = _fill_workday_page(page, safe_fields, resume_pdf, cover_letter, skip_resume=skip_resume, resume_data=resume_data, job_location=job_location, preferred_locations=preferred_locations)
                    history = state.get("fill_history") or []
                    history.append(fill_result)
                    state["fill_history"] = history[-10:]
                    state["last_fill"] = fill_result
                    # Persist a dedicated resume-attached flag that survives
                    # the capped fill_history[-10:] truncation: this is the
                    # primary idempotency signal _prior_resume_attached reads
                    # on a later continuation, so a resume already uploaded
                    # is never re-attached (which produced duplicate
                    # 'resume.pdf successfully uploaded' entries live).
                    if fill_result.get("resume_attached"):
                        state["resume_attached"] = True

                    # Unresolved inferred questions (e.g. relocation when
                    # the job location doesn't match a preferred location,
                    # or an AI attestation acknowledgment) must NOT be
                    # guessed. Checkpoint as manual review with the browser
                    # left open so the human can answer them, same fail-closed
                    # pattern as the post-Next validation-error path below.
                    unresolved = fill_result.get("unresolved_questions") or []
                    if unresolved:
                        state["status"] = "manual_review"
                        state["seen_signatures"] = list(seen_signatures)
                        notes = "; ".join(q.get("question", "?") for q in unresolved)
                        keep_browser_open = True
                        fill_record_extra = {}
                        fill_record_path = _maybe_record_fill(job_id, state, safe_fields)
                        if fill_record_path:
                            fill_record_extra["fill_record_path"] = fill_record_path
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday has required questions aplyx can't safely auto-answer: {notes}. The browser window is left open for you to answer these yourself. You MUST close this browser window before clicking Continue Workday again: a later runtime invocation cannot attach to the same Chrome profile while it is still open.", outcome="checkpoint", filled_fields=len(fill_result["filled_labels"]), resume_attached=fill_result["resume_attached"], unresolved_questions=unresolved, **fill_record_extra)

                    submit = _submit_button(page)
                    if submit is not None:
                        # Only attempt the final submit when we can confirm
                        # the page is actually the review/submit page.
                        # Workday surfaces submit buttons on account-creation
                        # and intermediate steps too; clicking submit on a
                        # non-final page is not a real application submit.
                        # Fails closed: if we can't confirm, save the
                        # checkpoint for human review instead of guessing.
                        if not _is_review_submit_page(page):
                            state["status"] = "ready_to_submit"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, True, "Workday reached a submit button but the page is not clearly the final review/submit step. Checkpoint saved. Open the browser and confirm the final submit yourself.", outcome="checkpoint", filled_fields=len(fill_result["filled_labels"]), resume_attached=fill_result["resume_attached"])

                        if no_submit:
                            state["status"] = "ready_to_submit"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, True, "Workday reached the final review/submit page. No-submit mode is enabled, so the application was NOT submitted.", outcome="checkpoint", filled_fields=len(fill_result["filled_labels"]), resume_attached=fill_result["resume_attached"])

                        submit_result = _attempt_final_submit(page, submit)
                        outcome = submit_result["outcome"]
                        confirmation_url = submit_result.get("confirmation_url") or page.url
                        filled_count = len(fill_result["filled_labels"])
                        resume_attached = fill_result["resume_attached"]

                        if outcome == "submitted":
                            state["status"] = "submitted"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, True, f"Workday application submitted. {submit_result['reason']}", outcome="submitted", confirmation_url=confirmation_url, filled_fields=filled_count, resume_attached=resume_attached)

                        if outcome == "challenge_detected":
                            state["status"] = "challenge_detected"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a challenge just before final submit: {submit_result['reason']}. Checkpoint saved. Resolve manually and re-run.", outcome="checkpoint", confirmation_url=confirmation_url, filled_fields=filled_count, resume_attached=resume_attached)

                        if outcome == "validation_error":
                            state["status"] = "submit_validation_error"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday submit was clicked but the form surfaced validation errors: {submit_result['reason']}. Checkpoint saved for retry.", outcome="failed", confirmation_url=confirmation_url, doubt_signals=["submit_outcome_unclear"], filled_fields=filled_count, resume_attached=resume_attached)

                        if outcome == "click_failed":
                            state["status"] = "submit_click_failed"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday final submit button was found but could not be clicked: {submit_result['reason']}. Checkpoint saved for retry.", outcome="failed", confirmation_url=confirmation_url, filled_fields=filled_count, resume_attached=resume_attached)

                        # outcome == "outcome_unclear": fail closed. Do NOT
                        # claim applied; the human must verify the result in
                        # the browser. This is the load-bearing safety
                        # property: no false "applied" outcome on ambiguity.
                        state["status"] = "submit_outcome_unclear"
                        state["seen_signatures"] = list(seen_signatures)
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday submit was clicked but the resulting page did not show an unambiguous confirmation. NOT recorded as applied: open the browser and verify manually. ({submit_result['reason']})", outcome="failed", confirmation_url=confirmation_url, doubt_signals=["submit_outcome_unclear"], filled_fields=filled_count, resume_attached=resume_attached)

                    next_button = _next_button(page)
                    if _looks_like_blank_autofill_shell(page, fill_result):
                        if _switch_to_apply_manually_url(page):
                            _ensure_apply_flow(page)
                            continue
                    if next_button is None:
                        state["status"] = "page_filled"
                        state["seen_signatures"] = list(seen_signatures)
                        return _emit_with_checkpoint(page, state_dir, job_id, state, True, "Workday page replayed, but no next/submit button was recognized. Checkpoint saved for the next continuation step.", filled_fields=len(fill_result["filled_labels"]), resume_attached=fill_result["resume_attached"])

                    try:
                        # Bounded retry, re-querying the Next button on
                        # each attempt: this is a non-final transition
                        # (unlike the final-submit click above, which is
                        # never wrapped in a retry), so a transiently
                        # unclickable control here is safe to retry.
                        click_with_retry(lambda: _next_button(page) or next_button, timeout_ms=1800)
                        _pause(1300, 260)

                        # A "Save and Continue"/"Next" click can fail
                        # client-side validation without raising anything
                        # (the page just stays put and shows inline
                        # errors): nothing above would notice, and the
                        # loop would otherwise only catch this later via
                        # the repeated-page-signature guard, which stops
                        # the run but with a much less actionable message
                        # than naming the actual fields. Check explicitly
                        # so the checkpoint tells the human exactly what
                        # to answer, same as the final-submit path
                        # already does.
                        page_errors = _validation_errors(page)
                        if page_errors:
                            state["status"] = "page_filled"
                            state["seen_signatures"] = list(seen_signatures)
                            note = "; ".join(page_errors[:5])
                            keep_browser_open = True
                            fill_record_extra = {}
                            fill_record_path = _maybe_record_fill(job_id, state, safe_fields)
                            if fill_record_path:
                                fill_record_extra["fill_record_path"] = fill_record_path
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday needs answers aplyx can't safely guess before continuing: {note}. The browser window is left open for you to answer these yourself. You MUST close this browser window before clicking Continue Workday again: a later runtime invocation cannot attach to the same Chrome profile while it is still open.", outcome="checkpoint", filled_fields=len(fill_result["filled_labels"]), resume_attached=fill_result["resume_attached"], **fill_record_extra)

                        state["status"] = "page_advanced"
                        state["last_fill"]["next_step_title"] = _workday_step_title(page)
                        state["last_fill"]["next_url"] = page.url
                        final_result = {
                            "message": "Workday page replayed and advanced to the next step. Continuing automatically.",
                            "filled_fields": len(fill_result["filled_labels"]),
                            "resume_attached": fill_result["resume_attached"],
                        }
                    except Exception as exc:
                        state["status"] = "page_filled"
                        state["last_fill"]["advance_error"] = str(exc)
                        state["seen_signatures"] = list(seen_signatures)
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday page was filled but the next step could not be activated. Checkpoint saved for retry.", filled_fields=len(fill_result["filled_labels"]), resume_attached=fill_result["resume_attached"])

                state["status"] = "page_advanced"
                state["seen_signatures"] = list(seen_signatures)
                return _emit_with_checkpoint(page, state_dir, job_id, state, True, (final_result or {}).get("message", "Workday advanced through multiple steps."), filled_fields=(final_result or {}).get("filled_fields", 0), resume_attached=(final_result or {}).get("resume_attached", False))

            state["status"] = "form_unrecognized"
            return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday page did not match a known account-setup or login state. Checkpoint saved for manual follow-up.")
        finally:
            if not keep_browser_open:
                try:
                    context.close()
                except Exception:
                    pass


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="approve_submit_workday.py",
        description="Scaffold Workday account creation / verification continuation for a local review-queue entry.",
    )
    parser.add_argument("job_id")
    parser.add_argument("--review-queue", default=DEFAULT_REVIEW_QUEUE)
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    # --alias-email is no longer required: a personal candidate email
    # (--account-email) from a connected/verified Gmail profile or
    # verification session is the preferred path. Exactly one of the two
    # must be supplied; the runtime enforces that in run().
    parser.add_argument("--alias-email")
    parser.add_argument("--alias-id")
    parser.add_argument("--account-email", help="Personal candidate email from a connected/verified Gmail profile or verification session; preferred over --alias-email")
    parser.add_argument("--apply-url", help="Canonical posting URL for a fresh scheduled run without a review-queue row")
    parser.add_argument("--job-location", help="Canonical job location for a fresh --apply-url run, used by relocation-inference; queue continuations read location from the queue entry instead")
    parser.add_argument("--resume-pdf", help="Path to a tailored resume PDF from Phase 2; falls back to the master resume when absent")
    parser.add_argument("--cover-letter", help="Path to a tailored cover letter text file from Phase 2; pasted into a cover-letter field if the form has one")
    parser.add_argument("--session-secret-file", help="Path to a JSON file {\"link\":...,\"otp\":...} or '-' for stdin: secure one-time secret handoff that keeps the raw value out of argv")
    parser.add_argument("--credential-file", help="Short-lived JSON credential handoff from the desktop app; password is never stored in the checkpoint")
    parser.add_argument("--no-submit", action="store_true")
    parser.add_argument("--user-data-dir")
    args = parser.parse_args(argv)
    if not args.alias_email and not args.account_email:
        parser.error("one of --alias-email or --account-email is required")
    cover_letter_text = None
    if args.cover_letter:
        try:
            with open(args.cover_letter, "r", encoding="utf-8") as fh:
                cover_letter_text = fh.read().strip() or None
        except OSError:
            cover_letter_text = None
    return run(args.job_id, args.review_queue, args.state_dir, args.alias_email, args.alias_id, args.no_submit, args.user_data_dir, args.apply_url, args.resume_pdf, cover_letter_text, args.account_email, args.session_secret_file, args.job_location, args.credential_file)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "message": f"unexpected error: {exc}"}))
        sys.exit(1)
