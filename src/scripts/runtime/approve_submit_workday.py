#!/usr/bin/env python3
"""approve_submit_workday.py — local account/verification/submit runtime for
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
import secrets
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

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
    default_chrome_user_data_dir,
    fill_field,
    find_queue_entry,
    is_profile_lock_error,
    resolve_resume_path,
)

DEFAULT_STATE_DIR = "data/workday_apply_runs"
WORKDAY_HOST_SUFFIX = ".myworkdayjobs.com"
TARGETS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "src", "config", "targets.json")
DEFAULT_RESUME_PDF = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "data", "resumes", "resume.pdf")
SCREENSHOTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "data", "screenshots")

SAFE_FIELD_LABELS = {
    "first_name": ["First Name", "Legal First Name", "Given Name", "First (Given) Name"],
    "last_name": ["Last Name", "Legal Last Name", "Family Name", "Surname", "Last (Family) Name"],
    "preferred_name": ["Preferred Name", "Preferred First Name"],
    "email": ["Email", "Email Address", "Primary Email", "E-mail"],
    "phone": ["Phone", "Phone Number", "Mobile Phone", "Mobile", "Mobile Number", "Telephone"],
    "address_line1": ["Address Line 1", "Street Address", "Address", "Address 1", "Mailing Address", "Street"],
    "address_line2": ["Address Line 2", "Apartment", "Suite", "Unit", "Address 2", "Apt"],
    "location": ["City", "Location", "Current Location", "City/Town", "Municipality"],
    "zip_code": ["Postal Code", "Zip Code", "ZIP", "Postal", "Zip"],
    "linkedin_url": ["LinkedIn", "LinkedIn Profile", "LinkedIn URL", "LinkedIn Profile URL"],
    "github_url": ["GitHub", "GitHub Profile", "GitHub URL", "GitHub Profile URL"],
    "linkedin_username": ["LinkedIn Username", "LinkedIn Handle"],
    "github_username": ["GitHub Username", "GitHub Handle"],
    "graduation_date": ["Graduation Date", "Expected Graduation Date", "Date of Graduation", "Expected Graduation"],
    "gpa": ["GPA", "Grade Point Average", "GPA Score"],
    "authorized_to_work": ["Authorized to Work", "Work Authorization", "Authorized to work in the US", "Work Authorization Status"],
    "require_sponsorship": ["Require Sponsorship", "Need Sponsorship", "Visa Sponsorship", "Will you now or in the future require sponsorship", "Sponsorship Requirement"],
    "citizenship_status": ["Citizenship Status", "Citizenship", "Country of Citizenship"],
    "currently_enrolled": ["Currently Enrolled", "Enrollment Status"],
    # EEO / self-identification fields are only matched when the user
    # explicitly supplied a value in safe_fields — never defaulted here.
    "ethnicity": ["Ethnicity", "Race", "Ethnic Origin"],
    "hispanic_or_latino": ["Hispanic or Latino", "Are you Hispanic or Latino"],
    "gender": ["Gender", "Gender Identity"],
    "disability_status": ["Disability Status", "Disability", "Do you have a disability"],
    "veteran_status": ["Veteran Status", "Veteran", "Are you a veteran", "Military Service"],
    "date_of_birth": ["Date of Birth", "DOB", "Birth Date"],
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
    # control — the primary control is that password/OTP are kept out
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


def _local_password_path(out_dir: str, job_id: str) -> str:
    return os.path.join(out_dir, ".secrets", f"{job_id}.json")


def _load_local_password(out_dir: str, job_id: str) -> str | None:
    """The Workday account password lives in its own sidecar file,
    never in the main checkpoint JSON that also carries page
    signatures, fill history, and verification metadata — the plan's
    checkpoint schema explicitly excludes passwords, and a real
    generated-then-forgotten password would otherwise have made every
    login retry re-create a new account instead of reusing the
    pending one. This is a deliberately narrow local-only stopgap:
    the plan's own "Local Install Strategy" section calls for this to
    move to the OS keychain, which is a separate, later package."""
    path = _local_password_path(out_dir, job_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return str(data.get("password")) if isinstance(data, dict) and data.get("password") else None
    except (OSError, json.JSONDecodeError):
        return None


def _save_local_password(out_dir: str, job_id: str, password: str) -> None:
    path = _local_password_path(out_dir, job_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"password": password}, fh)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


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


def _resume_pdf_path() -> str | None:
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


def _account_mode(page) -> str:
    try:
        if page.locator("[data-automation-id='verifyPassword']").count() > 0:
            return "create_account"
        if page.locator("[data-automation-id='password']").count() > 0 and page.locator("[data-automation-id='email']").count() > 0:
            return "login"
    except Exception:
        pass
    return "unknown"


def _still_on_login_page(page) -> bool:
    """True if the page is still showing the login form (email + password
    fields both present). Used to avoid assuming a login succeeded when
    the submit was clicked but the form stayed put — wrong credentials, a
    validation error, or a CAPTCHA challenge all leave the login form
    on screen. Fails closed: any uncertainty returns False only when the
    login fields are clearly gone."""
    try:
        if page.locator("[data-automation-id='password']").count() > 0 and page.locator("[data-automation-id='email']").count() > 0:
            return True
    except Exception:
        pass
    return False


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
        try:
            if page.locator(selector).count() > 0:
                return True
        except Exception:
            continue
    return _text_contains(page, ["verification code", "one-time passcode", "enter code"])


def _workday_step_title(page) -> str:
    # progressBarActiveStep is checked first: a real live-site finding
    # (2026-08-23, NVIDIA's Workday tenant) is that the multi-step apply
    # wizard doesn't change the URL between internal steps at all (it's
    # a client-side-only stepper) and none of the selectors below
    # actually match this employer's page, causing every step to
    # report the same generic page title. Since _page_signature combines
    # this title with the URL for loop detection, that combination made
    # every genuinely different step look identical — a false "stuck in
    # a loop" stop on real forward progress. progressBarActiveStep's
    # text is "current step N of M\n<Step Name>" — take the last
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


def _write_result(ok: bool, message: str, **extra) -> int:
    payload = {"ok": ok, "message": message, **extra}
    print(json.dumps(payload))
    return 0 if ok else 1


def _emit_with_checkpoint(page, state_dir: str, job_id: str, state: dict, ok: bool, message: str, **extra) -> int:
    screenshot_path = _capture_checkpoint_screenshot(page, job_id)
    if screenshot_path:
        state["screenshot_path"] = screenshot_path
        extra.setdefault("screenshot_path", screenshot_path)
    checkpoint = _save_state(state_dir, job_id, state)
    extra.setdefault("checkpoint", checkpoint)
    extra.setdefault("checkpoint_status", state.get("status"))
    return _write_result(ok, message, **extra)


def _fill_first_visible(page, selectors: list[str], value: str) -> bool:
    for selector in selectors:
        if _fill_if_visible(page, selector, value):
            return True
    return False


def _next_button(page):
    selectors = [
        "[data-automation-id='bottom-navigation-next-button']",
        "[data-automation-id='nextButton']",
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
    """Final application-submit control only — never the public posting
    `Apply` link. Workday surfaces submit buttons on account-creation and
    intermediate steps too, and the public posting page has its own `Apply`
    control that opens the application flow; matching either by name would
    let a non-final page read as ready-to-submit. Prefer explicit Workday
    automation IDs, then the narrow `Submit`/`Submit Application` button
    names. The caller still gates the actual click behind
    `_is_review_submit_page` — this selector just refuses to hand back a
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
    submit button alone is not enough — clicking submit on a non-final page
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
    # confirmation URL after a successful submit — and those live on
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
    confirmation_url. Never claims success on ambiguity — outcome_unclear
    is the fail-closed path. The click itself is a single direct
    `.click()`, never wrapped in click_with_retry — the plan forbids
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

    return {"outcome": "outcome_unclear", "reason": "submit was clicked but the resulting page did not show an unambiguous confirmation — NOT recorded as applied", "confirmation_url": page.url}


def _fill_workday_page(page, safe_fields: dict[str, str]) -> dict:
    filled: list[str] = []
    unmatched: list[str] = []
    for key, labels in SAFE_FIELD_LABELS.items():
        value = safe_fields.get(key, "")
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
        if not matched:
            unmatched.append(key)

    resume_path = _resume_pdf_path()
    resume_attached = False
    if resume_path:
        try:
            file_inputs = page.locator("input[type=file]")
            if file_inputs.count() > 0:
                status, _ = attach_resume(page, resume_path)
                resume_attached = status == "filled"
                if resume_attached:
                    _pause(2400, 500)
        except Exception:
            resume_attached = False

    return {
        "filled_labels": filled,
        "unmatched_keys": unmatched,
        "resume_attached": resume_attached,
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
    if button is None:
        return
    try:
        button.click(timeout=2000)
        _pause(1400, 260)
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


def run(job_id: str, review_queue_path: str, state_dir: str, alias_email: str, verification_link: str | None, verification_otp: str | None, alias_id: str | None = None, no_submit: bool = False, user_data_dir: str | None = None) -> int:
    entry = find_queue_entry(job_id, review_queue_path)
    apply_url = entry.get("apply_url") or entry.get("url")
    if not apply_url:
        return _write_result(False, f"job_id={job_id!r} has no apply_url or url")
    if not _looks_like_workday(str(apply_url)):
        return _write_result(False, "approve-submit scaffolding is only implemented for Workday entries right now")
    if not alias_email:
        return _write_result(False, "Workday account setup needs a managed mail.aplyx.app alias before it can continue")

    state = _load_state(state_dir, job_id)
    password = _load_local_password(state_dir, job_id) or _random_password()
    _save_local_password(state_dir, job_id, password)
    state.update({
        "job_id": job_id,
        "apply_url": str(apply_url),
        "alias_email": alias_email,
        "alias_id": alias_id,
        "status": str(state.get("status") or "initialized"),
    })
    safe_fields = _read_safe_fields()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return _write_result(False, "the 'playwright' pip package is not installed — run `pip3 install -r requirements.txt` first")

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
                return _write_result(False, "your default Chrome is already running with this profile — close Chrome and try again")
            return _write_result(False, f"could not launch Chrome: {exc}")

        page = context.pages[0] if context.pages else context.new_page()
        # Set True only at the one checkpoint where a human is expected
        # to pick up immediately in this same window (an unmapped
        # required field) — every other checkpoint/outcome keeps the
        # existing always-close behavior, so this doesn't change what
        # the existing test suite already covers.
        keep_browser_open = False
        try:
            page.goto(str(apply_url), wait_until="domcontentloaded")
            _pause(1200, 240)
            _ensure_apply_flow(page)

            challenge = detect_challenge(page)
            if challenge:
                state["status"] = "challenge_detected"
                return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a challenge ({challenge}) before account setup could proceed. Checkpoint saved — resolve manually and re-run.", outcome="checkpoint")

            if verification_link:
                page.goto(verification_link, wait_until="domcontentloaded")
                _pause(1200, 240)
                state["last_verification_link"] = verification_link
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
                    # Never persist the OTP itself — a one-way hash is
                    # enough for an audit trail (this value is never
                    # read back for a reuse decision anywhere in this
                    # file) without keeping a live verification code
                    # sitting in a checkpoint file on disk.
                    state["last_verification_otp_hash"] = hashlib.sha256(verification_otp.encode("utf-8")).hexdigest()
                    state["used_verification_otp"] = True
                    # Guard: if the page is still asking for a code, the
                    # OTP did not take (wrong/expired code, or a
                    # validation error). Checkpoint and stop rather than
                    # guessing — never proceed into page-fill on a page
                    # that is still the verification step.
                    if _otp_mode(page):
                        state["status"] = "awaiting_verification"
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday verification code was entered but the page is still asking for a code. Checkpoint saved — re-run with a fresh OTP.", outcome="checkpoint")
                    # OTP clearly cleared verification. Continue into
                    # login/page-fill below instead of forcing a re-run.
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

            mode = _account_mode(page)
            if mode == "create_account":
                challenge = detect_challenge(page)
                if challenge:
                    state["status"] = "challenge_detected"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a challenge ({challenge}) on the create-account page. Checkpoint saved — resolve manually and re-run.", outcome="checkpoint")
                _fill_if_visible(page, "[data-automation-id='email']", alias_email)
                _pause(220, 60)
                _fill_if_visible(page, "[data-automation-id='password']", password)
                _pause(220, 60)
                _fill_if_visible(page, "[data-automation-id='verifyPassword']", password)
                _pause(220, 60)
                _click_if_visible(page, "[data-automation-id='createAccountCheckbox']")
                _pause(220, 60)
                if not _submit_create_account(page):
                    state["status"] = "account_form_unrecognized"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday account form was found but the submit button could not be activated.")
                _pause(1800, 300)
                state["status"] = "awaiting_verification"
                return _emit_with_checkpoint(page, state_dir, job_id, state, True, "Workday account created. Waiting for verification mail on the managed alias; re-run once the link arrives.")

            if mode == "login":
                challenge = detect_challenge(page)
                if challenge:
                    state["status"] = "challenge_detected"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a challenge ({challenge}) on the login page. Checkpoint saved — resolve manually and re-run.", outcome="checkpoint")
                _fill_if_visible(page, "[data-automation-id='email']", alias_email)
                _pause(220, 60)
                _fill_if_visible(page, "[data-automation-id='password']", password)
                _pause(220, 60)
                if not _click_if_visible(page, "[data-automation-id='submitButton']"):
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
                    state["status"] = "login_failed"
                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday login submit was clicked but the page is still on the login screen.{note} Checkpoint saved for retry.", outcome="failed")
                state["status"] = "logged_in"

            if state.get("status") in {"logged_in", "verified", "page_filled", "page_advanced"} or mode == "unknown":
                seen_signatures = set(state.get("seen_signatures") or [])
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
                                _fill_if_visible(page, "[data-automation-id='email']", alias_email)
                                _pause(220, 60)
                                _fill_if_visible(page, "[data-automation-id='password']", password)
                                _pause(220, 60)
                                _fill_if_visible(page, "[data-automation-id='verifyPassword']", password)
                                _pause(220, 60)
                                _click_if_visible(page, "[data-automation-id='createAccountCheckbox']")
                                _pause(220, 60)
                                if not _submit_create_account(page):
                                    state["status"] = "account_form_unrecognized"
                                    state["seen_signatures"] = list(seen_signatures)
                                    return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday account form was reached during continuation, but the Create Account button could not be activated.")
                                _pause(1800, 300)
                                state["status"] = "awaiting_verification"
                                state["seen_signatures"] = list(seen_signatures)
                                return _emit_with_checkpoint(page, state_dir, job_id, state, True, "Workday account created during continuation. Waiting for verification mail on the managed alias; re-run once the link arrives.")
                        state["status"] = "create_account_path_missing"
                        state["seen_signatures"] = list(seen_signatures)
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday sign-in choice page was reached during continuation, but no create-account path was visible.")

                    fill_result = _fill_workday_page(page, safe_fields)
                    history = state.get("fill_history") or []
                    history.append(fill_result)
                    state["fill_history"] = history[-10:]
                    state["last_fill"] = fill_result

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
                            return _emit_with_checkpoint(page, state_dir, job_id, state, True, "Workday reached a submit button but the page is not clearly the final review/submit step. Checkpoint saved — open the browser and confirm the final submit yourself.", outcome="checkpoint", filled_fields=len(fill_result["filled_labels"]), resume_attached=fill_result["resume_attached"])

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
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday presented a challenge just before final submit: {submit_result['reason']}. Checkpoint saved — resolve manually and re-run.", outcome="checkpoint", confirmation_url=confirmation_url, filled_fields=filled_count, resume_attached=resume_attached)

                        if outcome == "validation_error":
                            state["status"] = "submit_validation_error"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday submit was clicked but the form surfaced validation errors: {submit_result['reason']}. Checkpoint saved for retry.", outcome="failed", confirmation_url=confirmation_url, doubt_signals=["submit_outcome_unclear"], filled_fields=filled_count, resume_attached=resume_attached)

                        if outcome == "click_failed":
                            state["status"] = "submit_click_failed"
                            state["seen_signatures"] = list(seen_signatures)
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday final submit button was found but could not be clicked: {submit_result['reason']}. Checkpoint saved for retry.", outcome="failed", confirmation_url=confirmation_url, filled_fields=filled_count, resume_attached=resume_attached)

                        # outcome == "outcome_unclear" — fail closed. Do NOT
                        # claim applied; the human must verify the result in
                        # the browser. This is the load-bearing safety
                        # property: no false "applied" outcome on ambiguity.
                        state["status"] = "submit_outcome_unclear"
                        state["seen_signatures"] = list(seen_signatures)
                        return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday submit was clicked but the resulting page did not show an unambiguous confirmation. NOT recorded as applied — open the browser and verify manually. ({submit_result['reason']})", outcome="failed", confirmation_url=confirmation_url, doubt_signals=["submit_outcome_unclear"], filled_fields=filled_count, resume_attached=resume_attached)

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
                        # each attempt — this is a non-final transition
                        # (unlike the final-submit click above, which is
                        # never wrapped in a retry), so a transiently
                        # unclickable control here is safe to retry.
                        click_with_retry(lambda: _next_button(page) or next_button, timeout_ms=1800)
                        _pause(1300, 260)

                        # A "Save and Continue"/"Next" click can fail
                        # client-side validation without raising anything
                        # (the page just stays put and shows inline
                        # errors) — nothing above would notice, and the
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
                            return _emit_with_checkpoint(page, state_dir, job_id, state, False, f"Workday needs answers aplyx can't safely guess before continuing: {note}. The browser window is left open — answer these yourself, then click Continue Workday again.", outcome="checkpoint", filled_fields=len(fill_result["filled_labels"]), resume_attached=fill_result["resume_attached"])

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

            if state.get("status") == "awaiting_verification":
                return _emit_with_checkpoint(page, state_dir, job_id, state, False, "Workday is still waiting on account verification. Re-run Continue Workday after the verification link arrives.")

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
    parser.add_argument("--alias-email", required=True)
    parser.add_argument("--alias-id")
    parser.add_argument("--verification-link")
    parser.add_argument("--otp")
    parser.add_argument("--no-submit", action="store_true")
    parser.add_argument("--user-data-dir")
    args = parser.parse_args(argv)
    return run(args.job_id, args.review_queue, args.state_dir, args.alias_email, args.verification_link, args.otp, args.alias_id, args.no_submit, args.user_data_dir)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "message": f"unexpected error: {exc}"}))
        sys.exit(1)
