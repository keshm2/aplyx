#!/usr/bin/env python3
"""approve_submit_greenhouse.py: deterministic approve-submit runtime for
ready_to_submit Greenhouse applications.

Starts from the same saved fill record replay_fill.py uses, replays the
already-decided values into a real visible Chrome window, then attempts the
final Greenhouse submit. No LLM calls, no new field decisions, no guessing:
if a field cannot be re-found or an obvious CAPTCHA/validation blocker
appears, the script returns a structured failure and does not submit.

This is intentionally Greenhouse-only in v1. Lever/Ashby/Workday get their
own family-specific submit runtimes later rather than over-generalizing the
first implementation.
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
    DEFAULT_REVIEW_QUEUE,
    DEFAULT_FILL_RECORDS_DIR,
    attach_resume,
    default_chrome_user_data_dir,
    fill_field,
    find_queue_entry,
    is_profile_lock_error,
    load_fill_record,
    resolve_resume_path,
)

GREENHOUSE_HOSTS = {"boards.greenhouse.io", "job-boards.greenhouse.io"}


def _pause(base_ms: int, variance_ms: int) -> None:
    delay = max(0, base_ms + random.randint(-variance_ms, variance_ms)) / 1000.0
    time.sleep(delay)


def _looks_like_greenhouse(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return False
    host = host.lower()
    return host in GREENHOUSE_HOSTS or host.endswith(".greenhouse.io")


def _has_captcha(page) -> bool:
    # Delegates to the shared, broader challenge detector (Package 4,
    # docs/ats-account-credentials-plan.md) so a hCaptcha/Cloudflare/
    # generic-overlay challenge is caught here too, not just recaptcha.
    return detect_challenge(page) is not None


def _find_submit(page):
    try:
        button = page.get_by_role("button", name="submit", exact=False)
        if button.count() >= 1:
            return button.first
    except Exception:
        pass
    try:
        button = page.locator("button[type=submit], input[type=submit]")
        if button.count() >= 1:
            return button.first
    except Exception:
        pass
    return None


def _validation_errors(page) -> list[str]:
    errors: list[str] = []
    selectors = [
        "[aria-invalid='true']",
        ".field-error",
        ".error",
        "[data-testid*='error']",
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
# no longer the form" is NOT — a failed submit that bounces to an SSO
# page, an error page, or the company careers site would otherwise be
# misreported as a successful application (worse than a false failure:
# the job gets logged as applied when nothing was sent).
_CONFIRMATION_URL_MARKERS = (
    "/thank", "/thanks", "/thank_you", "/thank-you",
    "/confirmation", "/confirm", "/submitted", "/success", "/complete",
)


def _looks_successful(page) -> tuple[bool, str]:
    body = ""
    try:
        body = (page.locator("body").inner_text(timeout=1000) or "").lower()
    except Exception:
        body = ""
    url = page.url.lower()
    success_phrases = [
        "thank you for applying",
        "thanks for applying",
        "application submitted",
        "application received",
        "we've received your application",
        "we have received your application",
        "your application has been submitted",
        "your application was submitted",
        "successfully submitted",
    ]
    for phrase in success_phrases:
        if phrase in body:
            return True, f"Greenhouse confirmation detected: {phrase}"
    if any(marker in url for marker in _CONFIRMATION_URL_MARKERS):
        return True, f"Greenhouse reached a confirmation page: {page.url}"
    return False, (
        f"submit did not reach a confirmation page (now at {page.url}); "
        "verify manually before marking this applied"
    )


def _embed_url(entry: dict, job_id: str) -> str | None:
    """Greenhouse's /embed/job_app endpoint renders the application form
    top-level on a greenhouse.io host. Reconstruct it from the company
    slug and the numeric job token so a stale queue entry (whose only URL
    is the company's own careers page, with the real form in an iframe)
    can still be filled. Newer entries already carry this as apply_url."""
    slug = (entry.get("company") or "").strip()
    token = (entry.get("external_job_id") or "").strip()
    if not token and job_id.startswith("greenhouse-"):
        token = job_id[len("greenhouse-"):]
    if slug and token.isdigit():
        return f"https://job-boards.greenhouse.io/embed/job_app?for={slug}&token={token}"
    return None


def _fail(page, message: str, code: int, job_id: str) -> int:
    """Print a structured failure, attaching a screenshot saved before the
    browser closes so the reason stays inspectable (the window itself is
    always closed on the way out, so it can't hold the profile lock the
    next run needs)."""
    out = {"ok": False, "message": message}
    shot = capture_debug_screenshot(page, f"greenhouse_{job_id}") if page is not None else None
    if shot:
        out["screenshot"] = shot
    print(json.dumps(out))
    return code


def _resume_path_from_fields(fields) -> str | None:
    for field in fields:
        if field.get("source") == "resume_upload":
            return resolve_resume_path(field.get("filled_value", ""))
    return None


def run(job_id: str, review_queue_path: str, fill_records_dir: str, use_api: bool = True) -> int:
    entry = find_queue_entry(job_id, review_queue_path)
    apply_url = entry.get("apply_url") or entry.get("url")
    if not apply_url:
        print(json.dumps({"ok": False, "message": f"job_id={job_id!r} has no apply_url or url"}))
        return 1
    # Trust an explicit source label even when the apply URL is a Greenhouse
    # form embedded on the company's own domain (careers.acme.com), where
    # the host check alone would wrongly bounce it.
    source = (entry.get("source") or "").lower()
    if source != "greenhouse" and not job_id.startswith("greenhouse-") and not _looks_like_greenhouse(str(apply_url)):
        print(json.dumps({"ok": False, "message": "approve-submit is only implemented for Greenhouse entries right now"}))
        return 1

    fields = load_fill_record(entry, fill_records_dir)

    # Official Job Board API first when the employer's board key is
    # available (APLYX_GREENHOUSE_BOARD_KEY or greenhouse_board_keys in
    # targets.json); otherwise this returns "fallback" and the browser
    # replay below runs unchanged. --no-api / APLYX_ATS_API_SUBMIT=0 skips it.
    api_note = ""
    if use_api:
        try:
            from ats_api_submit import try_api_submit

            api = try_api_submit("greenhouse", str(apply_url), fields, _resume_path_from_fields(fields))
            if api.get("status") == "submitted":
                out = {"ok": True, "message": api["message"], "via": "greenhouse_api"}
                out.update(api.get("extra") or {})
                print(json.dumps(out))
                return 0
            if api.get("status") != "skipped":
                api_note = api.get("reason") or ""
        except Exception as exc:  # noqa: BLE001
            api_note = f"API path errored ({exc})"

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"ok": False, "message": "the 'playwright' pip package is not installed; run `pip3 install -r requirements.txt` first"}))
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
                print(json.dumps({"ok": False, "message": "your default Chrome is already running with this profile; close Chrome and try again"}))
                return 3
            print(json.dumps({"ok": False, "message": f"could not launch Chrome: {exc}"}))
            return 3

        page = context.pages[0] if context.pages else context.new_page()
        try:
            goto_ready(page, str(apply_url))
            _pause(1200, 240)
            dismiss_consent_banner(page)

            if _has_captcha(page):
                return _fail(page, "Greenhouse form contains CAPTCHA; review manually instead of auto-submitting", 4, job_id)

            if not wait_for_form_ready(page):
                # The URL resolved to a page with no reachable form: most
                # often the company's own careers site with the real
                # Greenhouse form in an iframe. Retry on the top-level
                # /embed/job_app form.
                embed = _embed_url(entry, job_id)
                if embed and embed != str(apply_url):
                    goto_ready(page, embed)
                    _pause(1200, 240)
                    dismiss_consent_banner(page)
                if not wait_for_form_ready(page):
                    return _fail(page, "the Greenhouse application form did not finish loading, or the posting is no longer accepting applications; nothing was submitted", 9, job_id)

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
                return _fail(page, "Greenhouse form surfaced CAPTCHA after refill; review manually instead of auto-submitting", 4, job_id)

            submit = _find_submit(page)
            if submit is None:
                return _fail(page, "could not find a Greenhouse submit button", 6, job_id)

            try:
                submit.scroll_into_view_if_needed(timeout=2000)
            except Exception:
                pass
            submit.click(timeout=5000)
            _pause(1400, 280)

            errors = _validation_errors(page)
            if errors:
                return _fail(page, f"submit surfaced validation issues: {'; '.join(errors[:3])}", 7, job_id)

            deadline = time.monotonic() + 10.0
            last_reason = "submit did not reach an obvious Greenhouse confirmation state"
            while time.monotonic() < deadline:
                ok, last_reason = _looks_successful(page)
                if ok:
                    out = {"ok": True, "message": last_reason, "confirmation_url": page.url, "via": "browser"}
                    if api_note:
                        out["api_fallback"] = api_note
                    print(json.dumps(out))
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
        prog="approve_submit_greenhouse.py",
        description="Deterministically re-fill and submit a ready_to_submit Greenhouse application.",
    )
    parser.add_argument("job_id")
    parser.add_argument("--review-queue", default=DEFAULT_REVIEW_QUEUE)
    parser.add_argument("--fill-records-dir", default=DEFAULT_FILL_RECORDS_DIR)
    parser.add_argument("--no-api", action="store_true", help="skip the official-API submit path, use the browser only")
    args = parser.parse_args(argv)
    return run(args.job_id, args.review_queue, args.fill_records_dir, use_api=not args.no_api)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "message": f"unexpected error: {exc}"}))
        sys.exit(1)
