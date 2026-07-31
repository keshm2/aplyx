#!/usr/bin/env python3
"""replay_fill.py — deterministic, no-LLM review-queue reopen (Phase 16C,
Part B).

Reopens a needs_review application in the user's real default browser with
every field already replayed from its saved fill record (see
src/scripts/state/record_fill.py / AGENTS.md "Fill records"), the resume
re-attached, and the cover letter re-pasted — then stops. It never clicks
submit and there is no code path in this file that looks for a submit
button: this script can only replay values a human-supervised run already
decided and verified, never invent or guess anything new. That is what makes
this "deterministic" — it is a replay, not a re-fill, and it never invokes
an LLM/harness.

Requires the `playwright` pip package (see requirements.txt) and a real,
already-installed Google Chrome (uses Playwright's `channel="chrome"`, not
the bundled headless Chromium a Playwright install would otherwise fetch).

Run from the project root:
  python3 src/scripts/runtime/replay_fill.py <job_id>

Exit codes:
  0  success — filled fields (or none) and left the browser for the user
  1  usage / IO / JSON error (job not found, no fill record, malformed data)
  2  playwright not installed
  3  browser launch failed — most commonly the user's real Chrome is
     already running against the same profile (see KNOWN LIMITATION below)

KNOWN LIMITATION: Chrome refuses to open a second automated instance
against a profile directory that's already in use by a running Chrome
process. This script does not try to silently work around that (e.g. by
falling back to a different, unfamiliar profile) — it detects the failure
and tells the user to close their existing Chrome windows and try again.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

DEFAULT_REVIEW_QUEUE = "data/review_queue.json"
DEFAULT_FILL_RECORDS_DIR = "data/fill_records"
DEFAULT_RESUMES_DIR = "data/resumes"

IS_WINDOWS = os.name == "nt"
IS_MAC = sys.platform == "darwin"

# Substrings Chrome/Playwright are known to surface when a profile directory
# is already locked by a running browser process — used only to give the
# user an accurate, specific message; the failure is still surfaced (as
# exit code 3) even when none of these match.
_PROFILE_LOCK_HINTS = (
    "processsingleton",
    "singletonlock",
    "already running",
    "already in use",
    "user data directory",
)


def die(msg, code=1):
    print(f"replay_fill: {msg}", file=sys.stderr)
    sys.exit(code)


def load_json(path, label):
    if not os.path.exists(path):
        die(f"{label}: not found: {path}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"{label}: could not read {path}: {exc}")


def find_queue_entry(job_id, queue_path):
    queue = load_json(queue_path, "review queue")
    if not isinstance(queue, list):
        die(f"{queue_path}: expected a JSON array")
    for entry in queue:
        if entry.get("job_id") == job_id:
            return entry
    die(f"no review_queue.json entry for job_id={job_id!r}")


def load_fill_record(entry, fill_records_dir):
    path = entry.get("fill_record_path") or ""
    if not path:
        die(
            f"job_id={entry.get('job_id')!r} has no fill_record_path — nothing was "
            "ever filled for this job (e.g. a Workday entry, or a pre-tailoring "
            "reject), so there is nothing to replay"
        )
    if not os.path.isabs(path):
        # fill_record_path is normally already the path record_fill.py printed
        # (relative to the project root); resolve it defensively either way.
        candidate = os.path.join(PROJECT_ROOT, path)
        path = candidate if os.path.exists(candidate) else os.path.join(fill_records_dir, os.path.basename(path))
    record = load_json(path, "fill record")
    fields = record.get("fields")
    if not isinstance(fields, list) or not fields:
        die(f"{path}: fill record has no fields")
    return fields


def _within_resumes_dir(path):
    """True if the resolved, real path is actually inside data/resumes/.
    record_fill.py never validates the content of a fill record's
    filled_value (see src/scripts/state/record_fill.py) — it only checks
    field_name/source/verified/job_id — so a malformed or tampered fill
    record could name any absolute path on disk. Without this check, a
    resume_upload field would happily hand attach_resume() (and from there
    the real, live job-site page) an arbitrary local file — e.g.
    ~/.ssh/id_rsa or any other file the OS user can read — as a silent
    exfiltration path. Anchoring to the resumes directory is the same
    allowlist-not-denylist approach used for tenant hosts in the
    Workday/Oracle job-board adapters."""
    resumes_root = os.path.realpath(os.path.join(PROJECT_ROOT, DEFAULT_RESUMES_DIR))
    real = os.path.realpath(path)
    return os.path.commonpath([resumes_root, real]) == resumes_root


def resolve_resume_path(filename):
    """fill records store the resume as whatever record_fill.py was given for
    a resume_upload field — normally a bare filename like
    'base_resume_swe.pdf' (see src/agents/bodies/job-scraper.md Phase 3 step 4).
    Accept an absolute/relative path too, defensively — but only ever return
    a path that actually resolves inside data/resumes/ (see
    _within_resumes_dir)."""
    if os.path.isabs(filename) and os.path.exists(filename) and _within_resumes_dir(filename):
        return filename
    candidate = os.path.join(PROJECT_ROOT, DEFAULT_RESUMES_DIR, os.path.basename(filename))
    if os.path.exists(candidate) and _within_resumes_dir(candidate):
        return candidate
    candidate2 = os.path.join(PROJECT_ROOT, filename)
    if os.path.exists(candidate2) and _within_resumes_dir(candidate2):
        return candidate2
    return None


def default_chrome_user_data_dir():
    """The OS's real default Chrome profile root (contains the "Default"
    profile subfolder Chrome itself uses absent a --profile-directory flag).
    Deliberately the user's actual profile per operator decision — zero
    setup, at the cost of sharing history/cookies with normal browsing."""
    home = os.path.expanduser("~")
    if IS_MAC:
        return os.path.join(home, "Library", "Application Support", "Google", "Chrome")
    if IS_WINDOWS:
        local_appdata = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        return os.path.join(local_appdata, "Google", "Chrome", "User Data")
    return os.path.join(home, ".config", "google-chrome")


def is_profile_lock_error(exc):
    msg = str(exc).lower()
    return any(hint in msg for hint in _PROFILE_LOCK_HINTS)


# --- Field replay ------------------------------------------------------


def locate_field(page, field_name):
    """Best-effort locator for a human-readable field label. This is
    heuristic by nature (see module docstring) — a replay, not a re-fill,
    can only re-find fields via accessible name/label matching, unlike the
    original run which had an LLM visually/semantically identifying them."""
    candidates = [
        lambda: page.get_by_label(field_name, exact=False),
        lambda: page.get_by_placeholder(field_name, exact=False),
        lambda: page.get_by_role("textbox", name=field_name, exact=False),
        lambda: page.get_by_role("combobox", name=field_name, exact=False),
    ]
    for build in candidates:
        try:
            loc = build()
            if loc.count() >= 1:
                return loc.first
        except Exception:
            continue
    return None


def try_select_native(locator, value):
    try:
        locator.select_option(label=value)
        return True
    except Exception:
        return False


def try_combobox(page, locator, value):
    """Type the value, wait briefly for a rendered option list, click the
    option whose visible text matches exactly (case-insensitive, trimmed) —
    same no-guessing rule as the live Phase 3 dropdown protocol
    (src/agents/bodies/job-scraper.md). No exact match -> leave unfilled rather
    than commit whatever the widget happened to highlight."""
    try:
        locator.fill(value)
    except Exception:
        return False
    target = value.strip().lower()
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        try:
            options = page.get_by_role("option")
            n = options.count()
            for i in range(n):
                opt = options.nth(i)
                text = (opt.inner_text() or "").strip().lower()
                if text == target:
                    opt.click()
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    # No exact match — clear the typed text rather than leaving it sitting in
    # the box. An unconfirmed guess visually indistinguishable from a real
    # selection is exactly the failure mode this whole feature exists to
    # prevent; a reviewer glancing at the browser must never mistake
    # "unmatched" for "filled".
    try:
        locator.fill("")
    except Exception:
        pass
    return False


def fill_field(page, field_name, value):
    """Returns (status, note) where status is 'filled', 'skipped', or
    'unmatched'. Never raises — a replay failure for one field must not
    abort the rest of the form."""
    if value == "":
        return "skipped", "empty value — nothing to replay"
    locator = locate_field(page, field_name)
    if locator is None:
        return "unmatched", "no element found for this label"
    try:
        tag = (locator.evaluate("el => el.tagName") or "").lower()
    except Exception:
        tag = ""
    try:
        if tag == "select":
            ok = try_select_native(locator, value)
            return ("filled", "") if ok else ("unmatched", f"no exact <select> option for '{value}'")
        role = ""
        try:
            role = locator.evaluate("el => el.getAttribute('role') || ''") or ""
        except Exception:
            pass
        aria_expanded = ""
        try:
            aria_expanded = locator.evaluate("el => el.getAttribute('aria-expanded')") or ""
        except Exception:
            pass
        if role in ("combobox", "listbox") or aria_expanded != "" or tag == "input" and role == "combobox":
            ok = try_combobox(page, locator, value)
            return ("filled", "") if ok else ("unmatched", f"no exact dropdown option for '{value}'")
        locator.fill(value)
        return "filled", ""
    except Exception as exc:
        return "unmatched", f"error while filling: {exc}"


def attach_resume(page, resume_path):
    try:
        file_inputs = page.locator("input[type=file]")
        n = file_inputs.count()
    except Exception as exc:
        return "unmatched", f"could not enumerate file inputs: {exc}"
    if n == 0:
        return "unmatched", "no file input found on the page"
    target = file_inputs.first
    if n > 1:
        # Prefer a file input whose surrounding label/text mentions resume/cv.
        for i in range(n):
            candidate = file_inputs.nth(i)
            try:
                context_text = candidate.evaluate(
                    "el => (el.closest('label,fieldset,form')?.innerText || '').toLowerCase()"
                )
            except Exception:
                context_text = ""
            if "resume" in context_text or "cv" in context_text:
                target = candidate
                break
    try:
        target.set_input_files(resume_path)
        return "filled", ""
    except Exception as exc:
        return "unmatched", f"error attaching resume: {exc}"


# --- Main ----------------------------------------------------------------


def run(job_id, review_queue_path, fill_records_dir, user_data_dir=None, wait_ms=0, on_filled=None):
    entry = find_queue_entry(job_id, review_queue_path)
    fields = load_fill_record(entry, fill_records_dir)
    apply_url = entry.get("apply_url") or entry.get("url")
    if not apply_url:
        die(f"job_id={job_id!r} has no apply_url or url to open")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        die(
            "the 'playwright' pip package is not installed — run "
            "`pip3 install -r requirements.txt` first",
            code=2,
        )

    # user_data_dir is only overridable for tests (see src/scripts/runtime/ tests)
    # — normal use always drives the real default Chrome profile.
    user_data_dir = user_data_dir or default_chrome_user_data_dir()
    print(f"replay_fill: opening {apply_url}")
    print(f"replay_fill: using browser profile {user_data_dir}")

    with sync_playwright() as p:
        try:
            context = p.chromium.launch_persistent_context(
                user_data_dir,
                channel="chrome",
                headless=False,
                args=["--no-first-run"],
            )
        except Exception as exc:
            if is_profile_lock_error(exc):
                die(
                    "your default Chrome appears to already be running with this "
                    "profile — Playwright can't attach to a profile that's already "
                    "open. Close all Chrome windows and click Open again.",
                    code=3,
                )
            die(f"could not launch Chrome: {exc}", code=3)

        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(apply_url, wait_until="domcontentloaded")
        except Exception as exc:
            print(f"replay_fill: warning: navigation issue ({exc}); continuing anyway", file=sys.stderr)

        filled, unmatched, skipped = [], [], []
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
            else:
                status, note = fill_field(page, name, value)
            if status == "filled":
                filled.append(name)
            elif status == "skipped":
                skipped.append(name)
            else:
                unmatched.append((name, note))

        print(f"replay_fill: {len(filled)} field(s) replayed, {len(unmatched)} need manual attention, {len(skipped)} skipped (empty)")
        if unmatched:
            print("replay_fill: could not auto-fill — please check these by hand:")
            for name, note in unmatched:
                print(f"  - {name}: {note}")
        print("replay_fill: nothing was submitted. Review the form, then submit it yourself if it looks right.")
        print("replay_fill: leaving the browser open — close the window/tab when you're done.")

        if on_filled is not None:
            # Test-only hook: lets a test assert on `page` before the browser
            # is waited-on/closed. Never used in production (CLI never sets it).
            on_filled(page, filled, unmatched, skipped)

        try:
            # timeout=0 disables Playwright's default timeout — waits until the
            # human closes the window. Tests pass a real wait_ms so they don't
            # hang the suite; production always calls run() with the default 0.
            page.wait_for_event("close", timeout=wait_ms)
        except Exception:
            pass
        try:
            context.close()
        except Exception:
            pass

    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="replay_fill.py",
        description="Reopen a needs_review application pre-filled from its saved fill record (Phase 16C, Part B).",
    )
    parser.add_argument("job_id")
    parser.add_argument("--review-queue", default=DEFAULT_REVIEW_QUEUE)
    parser.add_argument("--fill-records-dir", default=DEFAULT_FILL_RECORDS_DIR)
    args = parser.parse_args(argv)

    os.chdir(PROJECT_ROOT)
    return run(args.job_id, args.review_queue, args.fill_records_dir)


if __name__ == "__main__":
    sys.exit(main())
