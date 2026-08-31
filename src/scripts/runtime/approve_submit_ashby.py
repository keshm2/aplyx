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

from browser_resilience import detect_challenge
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
    role_names = [
        "submit application",
        "submit",
        "apply",
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
    ]
    for phrase in success_phrases:
        if phrase in body:
            return True, f"Ashby confirmation detected: {phrase}"
    if "/thanks" in url or "/thank" in url or "/submitted" in url:
        return True, f"Ashby form redirected to {page.url}"
    if ASHBY_HOST not in url:
        return True, f"Ashby form redirected away from posting to {page.url}"
    return False, "submit did not reach an obvious Ashby confirmation state"


def run(job_id: str, review_queue_path: str, fill_records_dir: str) -> int:
    entry = find_queue_entry(job_id, review_queue_path)
    apply_url = entry.get("apply_url") or entry.get("url")
    if not apply_url:
        print(json.dumps({"ok": False, "message": f"job_id={job_id!r} has no apply_url or url"}))
        return 1
    if not _looks_like_ashby(str(apply_url)):
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
            page.goto(str(apply_url), wait_until="domcontentloaded")
            _pause(900, 180)

            if _has_captcha(page):
                print(json.dumps({"ok": False, "message": "Ashby form contains CAPTCHA; review manually instead of auto-submitting"}))
                return 4

            unmatched = []
            for field in fields:
                name = field.get("field_name", "")
                value = field.get("filled_value", "")
                source = field.get("source", "")
                if source == "resume_upload":
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
                print(json.dumps({"ok": False, "message": f"could not safely re-fill every field: {detail}"}))
                return 5

            if _has_captcha(page):
                print(json.dumps({"ok": False, "message": "Ashby form surfaced CAPTCHA after refill; review manually instead of auto-submitting"}))
                return 4

            submit = _find_submit(page)
            if submit is None:
                print(json.dumps({"ok": False, "message": "could not find an Ashby submit button"}))
                return 6

            submit.click(timeout=2000)
            _pause(1200, 240)

            errors = _validation_errors(page)
            if errors:
                print(json.dumps({"ok": False, "message": f"submit surfaced validation issues: {'; '.join(errors[:3])}"}))
                return 7

            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                ok, reason = _looks_successful(page)
                if ok:
                    print(json.dumps({"ok": True, "message": reason, "confirmation_url": page.url}))
                    return 0
                _pause(400, 100)

            print(json.dumps({"ok": False, "message": "submit did not reach an obvious Ashby confirmation state"}))
            return 8
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
