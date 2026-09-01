#!/usr/bin/env python3
"""approve_submit_ashby.py: deterministic approve-submit runtime for
ready_to_submit Ashby applications.

Replays a saved fill record into a real visible Chrome window, then attempts
the final Ashby submit. No LLM calls, no new field decisions, no guessing: if
the saved fields cannot be safely re-filled or the page surfaces an obvious
blocker (CAPTCHA, validation errors, missing submit button), the script
returns a structured failure and does not submit.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from urllib.parse import urlparse

from browser_resilience import (
    capture_debug_screenshot,
    detect_challenge,
    dismiss_consent_banner,
    goto_ready,
    wait_for_form_ready,
)
from replay_fill import (
    DEFAULT_FILL_RECORDS_DIR,
    DEFAULT_REVIEW_QUEUE,
    attach_resume,
    default_chrome_user_data_dir,
    fill_field,
    find_queue_entry,
    is_profile_lock_error,
    load_fill_record,
    resolve_resume_path,
)

ASHBY_HOST = "jobs.ashbyhq.com"


def _pause(base_ms: int, variance_ms: int) -> None:
    delay = max(0, base_ms + random.randint(-variance_ms, variance_ms)) / 1000.0
    time.sleep(delay)


def _looks_like_ashby(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return False
    return host.lower() == ASHBY_HOST


def _has_captcha(page) -> bool:
    # Delegates to the shared, broader challenge detector (Package 4,
    # docs/ats-account-credentials-plan.md).
    return detect_challenge(page) is not None


def _find_submit(page):
    # Ashby's real control is "Submit Application". A bare "apply" is
    # deliberately not matched: on some Ashby pages that is the pre-form
    # CTA that opens the application, not the final submit.
    role_names = [
        "submit application",
        "submit",
        "send application",
    ]
    for name in role_names:
        try:
            button = page.get_by_role("button", name=name, exact=False)
            if button.count() >= 1:
                return button.first
        except Exception:
            continue
    selectors = [
        "button[type=submit]",
        "input[type=submit]",
        "button[data-testid*='submit']",
        "button[class*='submit']",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            if loc.count() >= 1:
                return loc.first
        except Exception:
            continue
    return None


def _validation_errors(page) -> list[str]:
    errors: list[str] = []
    selectors = [
        "[aria-invalid='true']",
        ".error",
        ".field-error",
        "[data-testid*='error']",
        "[class*='errorMessage']",
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


# A confirmation-shaped URL path is a positive signal; a bare "the URL is
# no longer jobs.ashbyhq.com" is NOT — a failed submit that bounces to an
# SSO or error page elsewhere would otherwise be misreported as a
# successful application, and the job would be logged as applied when
# nothing was sent.
_CONFIRMATION_URL_MARKERS = (
    "/thank", "/thanks", "/thank-you", "/submitted",
    "/confirmation", "/confirm", "/success", "/complete",
)


def _looks_successful(page) -> tuple[bool, str]:
    body = ""
    try:
        body = (page.locator("body").inner_text(timeout=1000) or "").lower()
    except Exception:
        body = ""
    url = page.url.lower()
    success_phrases = [
        "application submitted",
        "thank you for applying",
        "thanks for applying",
        "application received",
        "we've received your application",
        "we have received your application",
        "submission received",
        "successfully submitted",
    ]
    for phrase in success_phrases:
        if phrase in body:
            return True, f"Ashby confirmation detected: {phrase}"
    if any(marker in url for marker in _CONFIRMATION_URL_MARKERS):
        return True, f"Ashby reached a confirmation page: {page.url}"
    return False, (
        f"submit did not reach a confirmation page (now at {page.url}); "
        "verify manually before marking this applied"
    )


def _fail(page, message: str, code: int, job_id: str) -> int:
    """Print a structured failure, attaching a screenshot saved before the
    browser closes so the reason stays inspectable (the window itself is
    always closed on the way out, so it can't hold the profile lock the
    next run needs)."""
    out = {"ok": False, "message": message}
    shot = capture_debug_screenshot(page, f"ashby_{job_id}") if page is not None else None
    if shot:
        out["screenshot"] = shot
    print(json.dumps(out))
    return code


def run(job_id: str, review_queue_path: str, fill_records_dir: str) -> int:
    entry = find_queue_entry(job_id, review_queue_path)
    apply_url = entry.get("apply_url") or entry.get("url")
    if not apply_url:
        print(json.dumps({"ok": False, "message": f"job_id={job_id!r} has no apply_url or url"}))
        return 1
    source = (entry.get("source") or "").lower()
    if source not in {"ashby", "ashbyhq"} and not _looks_like_ashby(str(apply_url)):
        print(json.dumps({"ok": False, "message": "approve-submit is only implemented for Ashby entries right now"}))
        return 1

    fields = load_fill_record(entry, fill_records_dir)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"ok": False, "message": "the 'playwright' pip package is not installed: run `pip3 install -r requirements.txt` first"}))
        return 2

    with sync_playwright() as p:
        try:
            context = p.chromium.launch_persistent_context(
                default_chrome_user_data_dir(),
                channel="chrome",
                headless=False,
                args=["--no-first-run"],
            )
        except Exception as exc:
            if is_profile_lock_error(exc):
                print(json.dumps({"ok": False, "message": "your default Chrome is already running with this profile: close Chrome and try again"}))
                return 3
            print(json.dumps({"ok": False, "message": f"could not launch Chrome: {exc}"}))
            return 3

        page = context.pages[0] if context.pages else context.new_page()
        try:
            goto_ready(page, str(apply_url))
            _pause(900, 180)
            dismiss_consent_banner(page)

            if _has_captcha(page):
                return _fail(page, "Ashby form contains CAPTCHA; review manually instead of auto-submitting", 4, job_id)

            if not wait_for_form_ready(page):
                return _fail(page, "the Ashby application form did not finish loading, or the posting is no longer accepting applications; nothing was submitted", 9, job_id)

            unmatched = []
            for field in fields:
                name = field.get("field_name", "")
                value = field.get("filled_value", "")
                field_source = field.get("source", "")
                if field_source == "resume_upload":
                    resume_path = resolve_resume_path(value)
                    if not resume_path:
                        unmatched.append((name, f"resume file not found: {value}"))
                        continue
                    status, note = attach_resume(page, resume_path)
                    _pause(2200, 400)
                else:
                    status, note = fill_field(page, name, value)
                    _pause(220, 60)
                if status == "unmatched":
                    unmatched.append((name, note))

            if unmatched:
                detail = "; ".join(f"{name}: {note}" for name, note in unmatched[:5])
                return _fail(page, f"could not safely re-fill every field: {detail}", 5, job_id)

            if _has_captcha(page):
                return _fail(page, "Ashby form surfaced CAPTCHA after refill; review manually instead of auto-submitting", 4, job_id)

            submit = _find_submit(page)
            if submit is None:
                return _fail(page, "could not find an Ashby submit button", 6, job_id)

            try:
                submit.scroll_into_view_if_needed(timeout=2000)
            except Exception:
                pass
            submit.click(timeout=5000)
            _pause(1200, 240)

            errors = _validation_errors(page)
            if errors:
                return _fail(page, f"submit surfaced validation issues: {'; '.join(errors[:3])}", 7, job_id)

            deadline = time.monotonic() + 10.0
            last_reason = "submit did not reach an obvious Ashby confirmation state"
            while time.monotonic() < deadline:
                ok, last_reason = _looks_successful(page)
                if ok:
                    print(json.dumps({"ok": True, "message": last_reason, "confirmation_url": page.url}))
                    return 0
                _pause(400, 100)

            return _fail(page, last_reason, 8, job_id)
        finally:
            try:
                context.close()
            except Exception:
                pass


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="approve_submit_ashby.py",
        description="Deterministically re-fill and submit a ready_to_submit Ashby application.",
    )
    parser.add_argument("job_id")
    parser.add_argument("--review-queue", default=DEFAULT_REVIEW_QUEUE)
    parser.add_argument("--fill-records-dir", default=DEFAULT_FILL_RECORDS_DIR)
    args = parser.parse_args(argv)
    return run(args.job_id, args.review_queue, args.fill_records_dir)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "message": f"unexpected error: {exc}"}))
        sys.exit(1)
