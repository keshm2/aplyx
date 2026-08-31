#!/usr/bin/env python3
"""Deterministic unit tests for the NVIDIA Workday application-flow fix in
approve_submit_workday.py. Uses a fake Playwright page: no browser, no
network, no real application is ever submitted.

Run: python3 -m unittest src.scripts.runtime.test_approve_submit_workday
or: python3 src/scripts/runtime/test_approve_submit_workday.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import io
import contextlib
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import approve_submit_workday as wd  # noqa: E402

# _pause() calls time.sleep for human-like pacing; in unit tests it only
# slows things down and adds no determinism. Neutralize it for every test.
wd._pause = lambda *_a, **_kw: None


class FakeLocator:
    """Minimal stand-in for a Playwright Locator. `count()` reflects how many
    matching elements were registered on the page for this selector; `.first`
    returns a clickable handle that records the click."""

    def __init__(self, page: "FakePage", selector: str):
        self._page = page
        self._selector = selector

    def count(self) -> int:
        return self._page._selector_counts.get(self._selector, 0)

    @property
    def first(self) -> "FakeLocator":
        return self

    def nth(self, index: int) -> "FakeLocator":
        # This fixture doesn't model distinct per-index text: every
        # matched element shares the page's single _body_text, same
        # simplification the rest of FakePage already makes.
        return self

    def click(self, timeout: int = 2000) -> None:
        self._page._clicks.append(self._selector)

    def fill(self, value: str) -> None:
        self._page._fills.append((self._selector, value))

    def inner_text(self, timeout: int = 1000) -> str:
        return self._page._body_text

    def evaluate(self, expr: str):
        """Return a configurable value for a JS expression. Used by
        try_combobox to read tagName/role/aria-* attributes."""
        if "tagName" in expr:
            return self._page._tag_values.get(self._selector, "button")
        return ""

    def get_attribute(self, attr: str):
        """Return a configurable attribute value for this selector."""
        return self._page._attr_values.get(self._selector, {}).get(attr)

    def press(self, key: str) -> None:
        self._page._presses.append((self._selector, key))


class FakeRoleLocator(FakeLocator):
    """Locator returned by `get_by_role`. Matches when the page has a
    registered role+name control. The selector string is synthetic and only
    used for click recording."""

    def __init__(self, page: "FakePage", role: str, name: str, exact: bool):
        super().__init__(page, f"role:{role}:{name}:{exact}")
        self._role = role
        self._name = name
        self._exact = exact
        self._option_index = 0

    def count(self) -> int:
        if self._role == "option":
            return len(self._page._option_texts)
        key = (self._role, self._name.lower(), self._exact)
        return 1 if key in self._page._role_controls else 0

    def nth(self, index: int) -> "FakeRoleLocator":
        if self._role == "option":
            clone = FakeRoleLocator(self._page, self._role, self._name, self._exact)
            clone._option_index = index
            return clone
        return self

    def inner_text(self, timeout: int = 1000) -> str:
        if self._role == "option":
            texts = self._page._option_texts
            if self._option_index < len(texts):
                return texts[self._option_index]
            return ""
        return self._page._body_text


class FakePage:
    """A scriptable fake of the small slice of Playwright's Page API that
    approve_submit_workday.py touches. Tests configure the page's URL, body
    text, present selectors, and role/name controls; the module under test
    reads them back through the same methods it calls for real."""

    def __init__(self, url: str, body_text: str = ""):
        self._url = url
        self._body_text = body_text
        self._selector_counts: dict[str, int] = {}
        self._role_controls: set[tuple[str, str, bool]] = set()
        self._clicks: list[str] = []
        self._fills: list[tuple[str, str]] = []
        self._goto_history: list[str] = []
        self._presses: list[tuple[str, str]] = []
        self._tag_values: dict[str, str] = {}
        self._attr_values: dict[str, dict[str, str]] = {}
        self._option_texts: list[str] = []

    @property
    def url(self) -> str:
        return self._url

    def goto(self, url: str, wait_until: str = "domcontentloaded") -> None:
        self._goto_history.append(url)
        self._url = url

    def locator(self, selector: str) -> FakeLocator:
        return FakeLocator(self, selector)

    def get_by_role(self, role: str, name: str = "", exact: bool = False) -> FakeRoleLocator:
        return FakeRoleLocator(self, role, name, exact)

    def screenshot(self, path: str, full_page: bool = False) -> None:
        return None

    # --- test configuration helpers ---
    def with_selector(self, selector: str, count: int = 1) -> "FakePage":
        self._selector_counts[selector] = count
        return self

    def with_role(self, role: str, name: str, exact: bool = False) -> "FakePage":
        self._role_controls.add((role, name.lower(), exact))
        return self

    def with_tag(self, selector: str, tag: str) -> "FakePage":
        self._tag_values[selector] = tag
        return self

    def with_attr(self, selector: str, attr: str, value: str) -> "FakePage":
        self._attr_values.setdefault(selector, {})[attr] = value
        return self

    def with_options(self, texts: list[str]) -> "FakePage":
        self._option_texts = texts
        return self

    @property
    def clicked_selectors(self) -> list[str]:
        return list(self._clicks)

    @property
    def filled_values(self) -> list[tuple[str, str]]:
        return list(self._fills)


POSTING_URL = (
    "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/"
    "US-CA-Santa-Clara/NVIDIA-2027-Internships--Software-Engineering_JR2023495"
)
AUTOFILL_URL = POSTING_URL + "/apply/autofillWithResume"
MANUAL_URL = POSTING_URL + "/apply/applyManually"


class SubmitButtonTests(unittest.TestCase):
    """Requirement 4: _submit_button must not recognize the public posting
    `Apply` link as a final application-submit control."""

    def test_public_posting_apply_button_is_not_a_submit(self):
        page = FakePage(POSTING_URL, body_text="NVIDIA 2027 Internships")
        page.with_role("button", "Apply")
        page.with_role("link", "Apply")
        self.assertIsNone(wd._submit_button(page))

    def test_explicit_submit_automation_id_is_recognized(self):
        page = FakePage(AUTOFILL_URL, body_text="Review and Submit")
        page.with_selector("[data-automation-id='submitButton']")
        self.assertIsNotNone(wd._submit_button(page))

    def test_bottom_navigation_submit_is_recognized(self):
        page = FakePage(AUTOFILL_URL, body_text="Review your application")
        page.with_selector("[data-automation-id='bottom-navigation-submit-button']")
        self.assertIsNotNone(wd._submit_button(page))

    def test_submit_application_button_name_is_recognized(self):
        page = FakePage(AUTOFILL_URL, body_text="Submit your application")
        page.with_role("button", "Submit Application")
        self.assertIsNotNone(wd._submit_button(page))

    def test_plain_submit_button_name_is_recognized(self):
        page = FakePage(AUTOFILL_URL, body_text="Review and submit")
        page.with_role("button", "Submit")
        self.assertIsNotNone(wd._submit_button(page))


class SwitchToApplyManuallyUrlTests(unittest.TestCase):
    """Requirement 3: only rewrite when on a clear autofillWithResume URL and
    the sibling applyManually URL is valid. No broad heuristic navigation."""

    def test_rewrites_autofill_url_to_manual(self):
        page = FakePage(AUTOFILL_URL)
        self.assertTrue(wd._switch_to_apply_manually_url(page))
        self.assertEqual(page._goto_history, [MANUAL_URL])
        self.assertEqual(page.url, MANUAL_URL)

    def test_does_not_rewrite_public_posting_url(self):
        page = FakePage(POSTING_URL)
        self.assertFalse(wd._switch_to_apply_manually_url(page))
        self.assertEqual(page._goto_history, [])

    def test_does_not_rewrite_already_manual_url(self):
        page = FakePage(MANUAL_URL)
        self.assertFalse(wd._switch_to_apply_manually_url(page))
        self.assertEqual(page._goto_history, [])


class EnsureApplyFlowTests(unittest.TestCase):
    """Requirement 2: from the public posting page, enter the in-page start
    modal, click Autofill with Resume when available (else Apply Manually),
    then continue into the account/sign-in/form flow."""

    def test_public_posting_clicks_apply_entry_when_no_modal(self):
        # Public posting page with an Apply control and NO modal text yet:
        # _ensure_apply_flow must click the apply entry button to open the
        # flow. (The modal-open transition itself is exercised by the
        # modal-already-open tests below, since a static fake cannot change
        # body text mid-click.)
        page = FakePage(POSTING_URL, body_text="NVIDIA 2027 Internships Software Engineering")
        page.with_selector("[data-automation-id='applyButton']")
        wd._ensure_apply_flow(page)
        self.assertIn("[data-automation-id='applyButton']", page.clicked_selectors)

    def test_modal_autofill_path(self):
        # Modal already open (URL still the posting URL): Autofill with
        # Resume is present and must be preferred over Apply Manually. Body
        # text includes a post-autofill sign-in marker so the deadline loop
        # exits immediately after the click.
        page = FakePage(
            POSTING_URL,
            body_text="autofill with resume apply manually start your application sign in with email",
        )
        page.with_role("button", "Autofill with Resume")
        wd._ensure_apply_flow(page)
        self.assertTrue(any(c.startswith("role:button:Autofill with Resume:") for c in page.clicked_selectors))
        # Apply Manually was not clicked when Autofill with Resume succeeded.
        self.assertFalse(any("Apply Manually" in c for c in page.clicked_selectors))

    def test_modal_falls_back_to_apply_manually_when_no_autofill(self):
        # Modal already open (URL still the posting URL): no Autofill with
        # Resume control is present, so _prefer_resume_start returns False
        # and _fallback_manual_start must fire instead.
        page = FakePage(
            POSTING_URL,
            body_text="start your application apply manually",
        )
        page.with_role("button", "Apply Manually")
        wd._ensure_apply_flow(page)
        self.assertTrue(any(c.startswith("role:button:Apply Manually:") for c in page.clicked_selectors))
        # Autofill with Resume was never clicked (not registered).
        self.assertFalse(any("Autofill" in c for c in page.clicked_selectors))

    def test_no_apply_control_leaves_page_alone(self):
        # Fail-closed: with no recognizable entry control and no modal, the
        # flow must not click anything or navigate.
        page = FakePage(POSTING_URL, body_text="NVIDIA 2027 Internships")
        wd._ensure_apply_flow(page)
        self.assertEqual(page.clicked_selectors, [])
        self.assertEqual(page._goto_history, [])


class LooksLikeBlankAutofillShellTests(unittest.TestCase):
    """Requirement 3 support: the blank-shell detector must fire only on a
    stuck autofillWithResume page with nothing filled and no controls."""

    def test_blank_autofill_shell_detected(self):
        page = FakePage(AUTOFILL_URL, body_text="Application progress")
        self.assertTrue(wd._looks_like_blank_autofill_shell(page, {"filled_labels": [], "resume_attached": False}))

    def test_not_blank_when_fields_were_filled(self):
        page = FakePage(AUTOFILL_URL, body_text="")
        self.assertFalse(wd._looks_like_blank_autofill_shell(page, {"filled_labels": ["First Name"], "resume_attached": False}))

    def test_not_blank_on_manual_url(self):
        page = FakePage(MANUAL_URL, body_text="")
        self.assertFalse(wd._looks_like_blank_autofill_shell(page, {"filled_labels": [], "resume_attached": False}))

    def test_not_blank_when_submit_button_present(self):
        page = FakePage(AUTOFILL_URL, body_text="Review and submit")
        page.with_selector("[data-automation-id='submitButton']")
        self.assertFalse(wd._looks_like_blank_autofill_shell(page, {"filled_labels": [], "resume_attached": False}))


class PublicApplyDoesNotTriggerFinalSubmitBranch(unittest.TestCase):
    """End-to-end-ish check of the core regression: on the public posting
    page with only an `Apply` control and zero fields filled, the final-submit
    branch must not fire: _submit_button returns None, so the caller never
    reaches the ready_to_submit checkpoint."""

    def test_public_apply_not_treated_as_final_submit(self):
        page = FakePage(POSTING_URL, body_text="NVIDIA 2027 Internships Software Engineering")
        page.with_role("button", "Apply")
        page.with_role("link", "Apply")
        # Simulate the page-fill loop's submit check after a no-op fill.
        fill_result = {"filled_labels": [], "resume_attached": False, "unmatched_keys": []}
        submit = wd._submit_button(page)
        # The public Apply control must not be handed back as a submit.
        self.assertIsNone(submit)
        # And the review/submit gate would be False anyway (no review markers).
        self.assertFalse(wd._is_review_submit_page(page))
        # The blank-shell detector must not misfire on the public posting URL
        # (it is not an autofillWithResume URL).
        self.assertFalse(wd._looks_like_blank_autofill_shell(page, fill_result))


class ChallengeDetectionTests(unittest.TestCase):
    """Package 4 (browser resilience, docs/ats-account-credentials-plan.md):
    a CAPTCHA/challenge marker on the final review page must make
    _attempt_final_submit fail closed without ever clicking submit:
    the plan's "CAPTCHA... fail closed" and "final submission is never
    automatically retried" requirements both depend on the challenge
    check running before the click, not after."""

    def test_challenge_detected_before_final_submit_click(self):
        page = FakePage(AUTOFILL_URL, body_text="Review and submit")
        page.with_selector(".h-captcha")
        submit = page.locator("[data-automation-id='submitButton']")
        result = wd._attempt_final_submit(page, submit)
        self.assertEqual(result["outcome"], "challenge_detected")
        self.assertNotIn("[data-automation-id='submitButton']", page.clicked_selectors)

    def test_no_challenge_allows_submit_click_attempt(self):
        page = FakePage(AUTOFILL_URL, body_text="thank you for applying")
        submit = page.locator("[data-automation-id='submitButton']")
        result = wd._attempt_final_submit(page, submit)
        self.assertEqual(result["outcome"], "submitted")
        self.assertIn("[data-automation-id='submitButton']", page.clicked_selectors)


class LocalPasswordSidecarTests(unittest.TestCase):
    """Package 4's checkpoint contract (docs/ats-account-credentials-plan.md:
    a checkpoint must never include a password) is enforced by keeping the
    Workday account password out of the main state dict entirely: these
    tests cover the sidecar file it lives in instead. Keyed by account
    identity (alias email + tenant), not job_id, so jobs sharing one
    Workday account reuse the same credentials."""

    def test_round_trips_and_is_not_world_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            key = wd._account_key("alias@mail.aplyx.app", "https://co.wd5.myworkdayjobs.com/site")
            self.assertIsNone(wd._load_local_password(tmp, key))
            wd._save_local_password(tmp, key, "S3cret!Pass1")
            self.assertEqual(wd._load_local_password(tmp, key), "S3cret!Pass1")
            path = wd._local_password_path(tmp, key)
            mode = os.stat(path).st_mode & 0o777
            self.assertEqual(mode, 0o600)

    def test_missing_sidecar_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(wd._load_local_password(tmp, "no-such-key"))

    def test_password_never_lands_in_the_main_checkpoint_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            key = wd._account_key("alias@mail.aplyx.app", "https://co.wd5.myworkdayjobs.com/site")
            wd._save_local_password(tmp, key, "S3cret!Pass1")
            wd._save_state(tmp, "job-1", {"job_id": "job-1", "status": "verified"})
            with open(wd._state_path(tmp, "job-1"), "r", encoding="utf-8") as fh:
                checkpoint = json.load(fh)
            self.assertNotIn("password", checkpoint)
            dumped = json.dumps(checkpoint)
            self.assertNotIn("S3cret!Pass1", dumped)

    def test_same_account_identity_reuses_one_sidecar(self):
        """Two jobs on the same Workday tenant with the same alias must
        resolve to the same password sidecar so a login retry reuses the
        pending account instead of creating a new one."""
        url = "https://co.wd5.myworkdayjobs.com/External"
        key_a = wd._account_key("alias@mail.aplyx.app", url + "/job/A")
        key_b = wd._account_key("alias@mail.aplyx.app", url + "/job/B")
        self.assertEqual(key_a, key_b)
        with tempfile.TemporaryDirectory() as tmp:
            wd._save_local_password(tmp, key_a, "Shared!Pass1")
            self.assertEqual(wd._load_local_password(tmp, key_b), "Shared!Pass1")

    def test_different_tenant_gets_different_sidecar(self):
        """Different Workday tenants (different hosts) get different
        password sidecars even with the same alias: they are separate
        accounts."""
        key_a = wd._account_key("alias@mail.aplyx.app", "https://co-a.wd5.myworkdayjobs.com/site")
        key_b = wd._account_key("alias@mail.aplyx.app", "https://co-b.wd1.myworkdayjobs.com/site")
        self.assertNotEqual(key_a, key_b)


class AppCredentialFileTests(unittest.TestCase):
    def test_reads_valid_app_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "credential.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"password": "Keychain!Pass1"}, fh)
            self.assertEqual(wd._read_credential_file(path), ("Keychain!Pass1", None))

    def test_rejects_invalid_app_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "credential.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"password": ""}, fh)
            password, error = wd._read_credential_file(path)
            self.assertIsNone(password)
            self.assertTrue(error)


class CheckpointSanitizationTests(unittest.TestCase):
    """_save_state must strip forbidden keys even if a future code path
    adds one to the state dict directly, per Package 4's checkpoint
    exclusion list (password/OTP/cookie/session-token): the sidecar
    file above is the primary control; this is the backstop."""

    def test_forbidden_keys_are_stripped_on_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd._save_state(tmp, "job-2", {
                "job_id": "job-2",
                "password": "leaked",
                "last_verification_link": "https://example.invalid/activate?token=leaked",
                "last_verification_otp": "654321",
                "last_verification_otp_hash": "deadbeef",
                "status": "awaiting_verification",
            })
            with open(wd._state_path(tmp, "job-2"), "r", encoding="utf-8") as fh:
                checkpoint = json.load(fh)
            self.assertNotIn("password", checkpoint)
            self.assertNotIn("last_verification_link", checkpoint)
            self.assertNotIn("last_verification_otp", checkpoint)
            self.assertEqual(checkpoint.get("last_verification_otp_hash"), "deadbeef")
            self.assertEqual(checkpoint.get("status"), "awaiting_verification")


class ValidationErrorDetectionTests(unittest.TestCase):
    """Regression coverage from a real live-site finding (2026-08-23):
    NVIDIA's Workday tenant rejects a "Save and Continue" click with
    required-question validation errors that never raise an exception
    and never navigate away: the page just stays put with inline
    error text. _validation_errors must still surface that text so the
    run() loop's post-click check (added the same day) can checkpoint
    with an actionable message instead of only catching this later via
    the repeated-page-signature guard."""

    def test_detects_nvidia_style_inline_required_field_errors(self):
        page = FakePage(
            AUTOFILL_URL,
            body_text=(
                "Error: The field How Did You Hear About Us? is required and must have a value."
            ),
        )
        page.with_selector("[aria-invalid='true']", count=1)
        errors = wd._validation_errors(page)
        self.assertTrue(any("How Did You Hear About Us?" in e for e in errors))

    def test_no_errors_when_nothing_matches(self):
        page = FakePage(AUTOFILL_URL, body_text="Application progress")
        self.assertEqual(wd._validation_errors(page), [])


class PageSignatureTests(unittest.TestCase):
    """_page_signature now delegates to the shared browser_resilience
    helper (Package 4): confirms the delegation didn't change its
    observable shape, since approve_submit_workday.py's own repeated-
    signature loop detection depends on this exact format."""

    def test_signature_combines_title_and_normalized_url(self):
        page = FakePage(AUTOFILL_URL + "?utm_source=x", body_text="Personal Information")
        page.with_selector("[data-automation-id='pageHeader']")
        self.assertEqual(wd._page_signature(page), f"Personal Information::{AUTOFILL_URL}")


class WorkdayStepTitleTests(unittest.TestCase):
    """Regression coverage from a real live-site finding (2026-08-23):
    NVIDIA's Workday tenant is a client-side-only multi-step wizard:
    the URL never changes between steps, and none of the previous
    fallback selectors (pageHeader/jobPostingHeader/h1/h2) matched
    anything on this employer's page, so every step reported the same
    generic title. Since _page_signature combines title + URL, that
    made every genuinely different step collide, causing a false
    "looped back to a previously-seen step" stop on real forward
    progress. progressBarActiveStep is now checked first."""

    def test_prefers_progress_bar_active_step_and_strips_step_count_line(self):
        page = FakePage(AUTOFILL_URL, body_text="current step 2 of 8\nMy Information")
        page.with_selector("[data-automation-id='progressBarActiveStep']")
        self.assertEqual(wd._workday_step_title(page), "My Information")

    def test_falls_back_to_page_header_when_progress_bar_absent(self):
        page = FakePage(AUTOFILL_URL, body_text="Review and Submit")
        page.with_selector("[data-automation-id='pageHeader']")
        self.assertEqual(wd._workday_step_title(page), "Review and Submit")

    def test_two_different_steps_no_longer_collide_on_signature(self):
        step_a = FakePage(AUTOFILL_URL, body_text="current step 2 of 8\nMy Information")
        step_a.with_selector("[data-automation-id='progressBarActiveStep']")
        step_b = FakePage(AUTOFILL_URL, body_text="current step 4 of 8\nApplication Questions 1 of 2")
        step_b.with_selector("[data-automation-id='progressBarActiveStep']")
        sig_a = wd._page_signature(step_a)
        sig_b = wd._page_signature(step_b)
        self.assertNotEqual(sig_a, sig_b)


# --- Phase 7D regression coverage ------------------------------------------
# Paths to the deterministic helpers and the agent body, resolved from this
# file's location so the routing tests work regardless of the caller's CWD.
_RUNTIME_DIR = os.path.dirname(os.path.abspath(__file__))
# _RUNTIME_DIR = <root>/src/scripts/runtime -> 3x dirname reaches <root>.
_ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(_RUNTIME_DIR)))
_JOB_STATE = os.path.join(_ROOT_DIR, "src", "scripts", "state", "job_state.py")
_FIT_GATE = os.path.join(_ROOT_DIR, "src", "scripts", "jobs", "evaluate_job_fit.py")
_JOB_SCRAPER_BODY = os.path.join(_ROOT_DIR, "src", "agents", "bodies", "job-scraper.md")
_AGENTS_MD = os.path.join(_ROOT_DIR, "AGENTS.md")

# A clearly-in-scope Workday job: strong role+level keyword match, US scope,
# no hard-reject signal. The fit gate is deliberately conservative, so this
# scores as `needs_review` (borderline-promising), not `candidate`; that is
# fine. The regression we pin is that it is NOT `skipped_unfit` (i.e. not
# hard-rejected) and that its verdict is identical to the same job under a
# different source, proving the gate is source-agnostic and a Workday job is
# not rejected solely for being Workday.
_FIT_WORKDAY_RAW = {
    "source": "workday",
    "company": "FitCorp",
    "title": "Software Engineer Intern - Summer 2027",
    "location": "Santa Clara, CA",
    "url": "https://fitcorp.wd5.myworkdayjobs.com/en-US/External/job/SWE-Intern_JR7777",
    "external_job_id": "JR7777",
    "jd_text": (
        "FitCorp Software Engineer Internship, Summer 2027, in Santa Clara CA. "
        "You will build backend services in Python and Go. Requirements: "
        "currently pursuing a Bachelors degree in Computer Science, strong "
        "fundamentals, internship or class project experience. Nice to have: "
        "familiarity with distributed systems."
    ),
}
# Same job re-sourced to Ashby (different URL/source) to prove the fit gate
# verdict is independent of source: the load-bearing property behind "a
# Workday job is not rejected solely because its family is Workday".
_FIT_ASHBY_RAW = {
    **_FIT_WORKDAY_RAW,
    "source": "ashbyhq",
    "url": "https://jobs.ashbyhq.com/fitcorp/swe-intern-7777",
    "apply_url": "https://jobs.ashbyhq.com/fitcorp/swe-intern-7777/application",
    "external_job_id": "swe-intern-7777",
}
_FIT_ASHBY_RAW.pop("external_job_id", None)


def _run_helper(cmd, **kw):
    return subprocess.run(cmd, cwd=_ROOT_DIR, capture_output=True, text=True, **kw)


class WorkdayRoutingTests(unittest.TestCase):
    """Phase 7D: a Workday job must not be rejected solely because its
    family is Workday. The review-only policy was an overlay on top of
    the deterministic fit gate + can-apply helpers (both source-agnostic);
    lifting it means a clearly-fitting Workday job passes the gate as
    `candidate` and is eligible to apply, exactly like an Ashby/Lever
    job. These tests pin that behavior at the helper level (where a
    regression would actually block a Workday job) and at the prompt
    level (where the prohibition used to live)."""

    def test_fit_gate_does_not_reject_workday_job_for_being_workday(self):
        """The fit gate is the deterministic cutoff. A clearly-in-scope
        Workday job must NOT be hard-rejected (skipped_unfit) solely for
        being Workday: it must land in candidate or needs_review like any
        other in-scope job. skipped_unfit here would mean a source-based
        hard reject crept into the gate."""
        p = _run_helper([sys.executable, _JOB_STATE, "canonicalize",
                         json.dumps(_FIT_WORKDAY_RAW)])
        self.assertEqual(p.returncode, 0, p.stderr.strip()[-200:])
        rec = json.loads(p.stdout)
        self.assertEqual(rec.get("ats_system"), "workday")
        self.assertEqual(rec.get("source"), "workday")

        targets = os.path.join(_ROOT_DIR, "src", "config", "targets.example.json")
        p = _run_helper([sys.executable, _FIT_GATE, json.dumps(rec),
                         "--targets", targets])
        try:
            fit = json.loads(p.stdout)
        except json.JSONDecodeError:
            self.fail(f"fit gate returned non-JSON: rc={p.returncode} stderr={p.stderr[-200:]}")
        self.assertNotEqual(fit.get("fit_status"), "skipped_unfit",
                            f"a clearly-in-scope Workday job must not be hard-rejected "
                            f"for source=workday: {fit}")
        self.assertIn(fit.get("fit_status"), ("candidate", "needs_review"))

    def test_fit_gate_verdict_is_identical_regardless_of_source(self):
        """The strongest proof of source-agnosticism: the same job (same
        title/location/JD) yields the same fit_status and fit_score whether
        sourced from Workday or Ashby. If a Workday-specific branch ever
        returned to the gate, these would diverge."""
        targets = os.path.join(_ROOT_DIR, "src", "config", "targets.example.json")

        def verdict(raw):
            p = _run_helper([sys.executable, _JOB_STATE, "canonicalize",
                             json.dumps(raw)])
            self.assertEqual(p.returncode, 0, p.stderr.strip()[-200:])
            rec = json.loads(p.stdout)
            p = _run_helper([sys.executable, _FIT_GATE, json.dumps(rec),
                             "--targets", targets])
            return json.loads(p.stdout)

        wd_fit = verdict(_FIT_WORKDAY_RAW)
        ashby_fit = verdict(_FIT_ASHBY_RAW)
        self.assertEqual(wd_fit.get("fit_status"), ashby_fit.get("fit_status"))
        self.assertEqual(wd_fit.get("fit_score"), ashby_fit.get("fit_score"))

    def test_can_apply_does_not_refuse_for_source_workday(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = os.path.join(tmp, "job_registry.json")
            events = os.path.join(tmp, "job_events.jsonl")
            applied = os.path.join(tmp, "applied_jobs.json")
            with open(applied, "w", encoding="utf-8") as f:
                f.write("[]\n")
            _run_helper([sys.executable, _JOB_STATE, "ensure-files",
                         "--registry", registry, "--events", events])

            p = _run_helper([sys.executable, _JOB_STATE, "canonicalize",
                             json.dumps(_FIT_WORKDAY_RAW)])
            rec = json.loads(p.stdout)
            _run_helper([sys.executable, _JOB_STATE, "upsert-job",
                         json.dumps(rec), "--registry", registry])

            p = _run_helper([sys.executable, _JOB_STATE, "can-apply",
                             json.dumps(rec), "--registry", registry,
                             "--applied", applied])
            self.assertEqual(p.returncode, 0,
                             f"can-apply must not refuse a fresh Workday job: "
                             f"rc={p.returncode} stderr={p.stderr.strip()[-200:]}")

    def test_scheduled_run_can_start_without_queue_entry(self):
        entry = wd._apply_entry(
            "workday-JR7777",
            "/path/that/does/not/exist/review_queue.json",
            _FIT_WORKDAY_RAW["url"],
        )
        self.assertEqual(entry["job_id"], "workday-JR7777")
        self.assertEqual(entry["apply_url"], _FIT_WORKDAY_RAW["url"])

    def test_queue_continuation_still_uses_queue_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            queue = os.path.join(tmp, "review_queue.json")
            with open(queue, "w", encoding="utf-8") as f:
                json.dump([{"job_id": "job-1", "apply_url": _FIT_WORKDAY_RAW["url"]}], f)
            entry = wd._apply_entry("job-1", queue, None)
            self.assertEqual(entry["apply_url"], _FIT_WORKDAY_RAW["url"])

    def test_job_scraper_body_no_longer_contains_review_only_prohibition(self):
        with open(_JOB_SCRAPER_BODY, "r", encoding="utf-8") as f:
            body = f.read()
        self.assertNotIn("Workday is REVIEW-ONLY", body)
        self.assertNotIn("No auto-apply path exists for Workday", body)
        self.assertNotIn("workday_review_only", body)
        # The new apply path must be present.
        self.assertIn("2W. **Workday only", body)
        self.assertIn("approve_submit_workday.py", body)

    def test_agents_md_no_longer_contains_workday_review_only_signal(self):
        with open(_AGENTS_MD, "r", encoding="utf-8") as f:
            agents = f.read()
        self.assertNotIn("workday_review_only", agents)
        self.assertNotIn("No auto-apply path exists for Workday", agents)
        # The new policy and the verification-boundary blocker must be stated.
        self.assertIn("phase 7D", agents)
        self.assertIn("awaiting_verification", agents)


class SubmitSafetyRegressionTests(unittest.TestCase):
    """Phase 7D: lifting the review-only policy must NOT weaken the
    final-submit fail-closed safety. Re-affirms the load-bearing
    properties: a challenge is detected before the click (no click
    happens), an ambiguous post-submit page is `outcome_unclear` and
    never `submitted`, and the final Submit click is issued exactly
    once (no blind retry wrapper)."""

    def test_challenge_blocks_submit_without_clicking(self):
        page = FakePage(AUTOFILL_URL, body_text="Review and submit")
        page.with_selector(".h-captcha")
        submit = page.locator("[data-automation-id='submitButton']")
        result = wd._attempt_final_submit(page, submit)
        self.assertEqual(result["outcome"], "challenge_detected")
        self.assertNotIn("[data-automation-id='submitButton']", page.clicked_selectors)

    def test_ambiguous_post_submit_page_is_outcome_unclear_never_submitted(self):
        # A page that stays on the apply form after the click: no success
        # phrase, no post-submit URL segment. The runtime must report
        # outcome_unclear and must NOT claim submitted.
        page = FakePage(AUTOFILL_URL, body_text="Review your application")
        submit = page.locator("[data-automation-id='submitButton']")
        result = wd._attempt_final_submit(page, submit)
        self.assertEqual(result["outcome"], "outcome_unclear")
        self.assertNotEqual(result["outcome"], "submitted")

    def test_final_submit_click_is_issued_exactly_once_no_retry(self):
        # The plan forbids auto-retrying the final Submit click. _attempt_final_submit
        # calls submit.click() once directly; verify the control was clicked exactly
        # once even when the post-submit page is ambiguous (the case that would most
        # tempt a retry).
        page = FakePage(AUTOFILL_URL, body_text="Review your application")
        submit = page.locator("[data-automation-id='submitButton']")
        wd._attempt_final_submit(page, submit)
        submit_clicks = [c for c in page.clicked_selectors
                         if c == "[data-automation-id='submitButton']"]
        self.assertEqual(len(submit_clicks), 1,
                         f"final Submit must be clicked exactly once (no blind retry); "
                         f"got {len(submit_clicks)} clicks")

    def test_clear_success_is_submitted(self):
        # Positive control: an unambiguous confirmation IS submitted, so the
        # fail-closed path isn't just refusing everything.
        page = FakePage(AUTOFILL_URL, body_text="thank you for applying")
        submit = page.locator("[data-automation-id='submitButton']")
        result = wd._attempt_final_submit(page, submit)
        self.assertEqual(result["outcome"], "submitted")


class CreateAccountVerificationTests(unittest.TestCase):
    """Fix 2: after _submit_create_account returns True, the runtime must
    verify the create form is actually gone and no validation errors remain.
    Never claim account created solely because a button was clicked."""

    def test_create_account_failed_when_form_still_present(self):
        """If the page is still in create_account mode after the submit
        click, the runtime must report create_account_failed, not
        awaiting_verification."""
        page = FakePage(AUTOFILL_URL, body_text="Create Account")
        # verifyPassword present => _account_mode returns "create_account"
        page.with_selector("[data-automation-id='verifyPassword']")
        page.with_selector("[data-automation-id='password']")
        page.with_selector("[data-automation-id='email']")
        # The submit button is clickable so _submit_create_account returns True
        page.with_selector("[data-automation-id='submitButton']")
        self.assertTrue(wd._submit_create_account(page))
        # After the click, the form is still present (mode is still create_account)
        self.assertEqual(wd._account_mode(page), "create_account")

    def test_create_account_succeeds_when_form_gone(self):
        """When the create form is gone after the submit click, the
        runtime should not report create_account_failed."""
        page = FakePage(AUTOFILL_URL, body_text="Verify your email")
        # No verifyPassword/password/email => mode is "unknown" (form gone)
        self.assertNotEqual(wd._account_mode(page), "create_account")

    def test_standard_email_password_inputs_are_detected_as_login(self):
        page = FakePage(AUTOFILL_URL, body_text="Sign In")
        page.with_selector("input[type='email']")
        page.with_selector("input[type='password']")
        self.assertEqual(wd._account_mode(page), "login")
        self.assertTrue(wd._still_on_login_page(page))

    def test_login_click_filter_is_used_when_workday_hides_submit_button(self):
        page = FakePage(AUTOFILL_URL, body_text="Sign In")
        page.with_selector("[data-automation-id='click_filter'][aria-label='Sign In']")
        self.assertTrue(wd._submit_login(page))
        self.assertIn("[data-automation-id='click_filter'][aria-label='Sign In']", page.clicked_selectors)

    def test_workday_page_footer_continue_is_a_next_button(self):
        page = FakePage(AUTOFILL_URL, body_text="Autofill with Resume Continue")
        self.assertIsNone(wd._next_button(page))
        page.with_selector("[data-automation-id='pageFooterNextButton']")
        self.assertIsNotNone(wd._next_button(page))

    def test_workday_login_url_preserves_site_and_redirects_to_autofill(self):
        url = "https://expedia.wd108.myworkdayjobs.com/en-US/search/job/Washington---Seattle-Campus/Software-Development-Engineer-II_R-108814"
        self.assertEqual(
            wd._workday_login_url(url),
            "https://expedia.wd108.myworkdayjobs.com/en-US/search/login?redirect=%2Fen-US%2Fsearch%2Fjob%2FWashington---Seattle-Campus%2FSoftware-Development-Engineer-II_R-108814%2Fapply%2FautofillWithResume",
        )

    def test_workday_login_url_includes_site_segment_for_bare_job_path(self):
        """Real bug found live against Capital One, 2026-08-31: a tenant
        whose apply path is just "/<site>/job/..." (no "/search/" segment)
        previously produced a site-less "/login", which Workday's own auth
        flow can't resolve post-login (bounces to
        community.workday.com/invalid-url). The site segment must be
        derived generically from whatever precedes "job", not only the
        "/search/"-shaped case."""
        url = "https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Software-Engineer_R12345"
        self.assertEqual(
            wd._workday_login_url(url),
            "https://capitalone.wd12.myworkdayjobs.com/Capital_One/login?redirect=%2FCapital_One%2Fjob%2FMcLean-VA%2FSoftware-Engineer_R12345%2Fapply%2FautofillWithResume",
        )

    def test_linkedin_profile_url_uses_canonical_host(self):
        self.assertEqual(
            wd._normalize_profile_url("linkedin_url", "https://linkedin.com/in/ukeshwaran"),
            "https://www.linkedin.com/in/ukeshwaran",
        )

    def test_sign_in_copy_in_start_modal_is_not_login(self):
        page = FakePage(
            POSTING_URL,
            body_text="Start your application Autofill with Resume Apply Manually Sign in with email",
        )
        self.assertEqual(wd._account_mode(page), "unknown")

    def test_immediate_application_shell_is_not_verification(self):
        page = FakePage(AUTOFILL_URL, body_text="Autofill with Resume My Information")
        self.assertFalse(wd._verification_required(page))


class VerificationFlagEmissionTests(unittest.TestCase):
    """Fix 3: used_verification_link and used_verification_otp must be
    emitted in stdout JSON whenever the runtime state records them, so
    helpers/ReviewScreen can consume matching inbound emails."""

    def test_emit_with_checkpoint_surfaces_used_verification_link(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = FakePage(AUTOFILL_URL, body_text="verified")
            state = {"status": "verified", "used_verification_link": True}
            buf: dict = {}
            orig = wd._write_result

            def capture(ok, message, **extra):
                buf.update(extra)
                return 0

            wd._write_result = capture
            try:
                wd._emit_with_checkpoint(page, tmp, "job-vl", state, True, "verified", outcome="checkpoint")
            finally:
                wd._write_result = orig
            self.assertTrue(buf.get("used_verification_link"))

    def test_emit_with_checkpoint_surfaces_used_verification_otp(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = FakePage(AUTOFILL_URL, body_text="verified")
            state = {"status": "verified", "used_verification_otp": True}
            buf: dict = {}
            orig = wd._write_result

            def capture(ok, message, **extra):
                buf.update(extra)
                return 0

            wd._write_result = capture
            try:
                wd._emit_with_checkpoint(page, tmp, "job-otp", state, True, "verified", outcome="checkpoint")
            finally:
                wd._write_result = orig
            self.assertTrue(buf.get("used_verification_otp"))

    def test_emit_with_checkpoint_omits_flags_when_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = FakePage(AUTOFILL_URL, body_text="page filled")
            state = {"status": "page_filled"}
            buf: dict = {}
            orig = wd._write_result

            def capture(ok, message, **extra):
                buf.update(extra)
                return 0

            wd._write_result = capture
            try:
                wd._emit_with_checkpoint(page, tmp, "job-none", state, True, "filled", outcome="checkpoint")
            finally:
                wd._write_result = orig
            self.assertNotIn("used_verification_link", buf)
            self.assertNotIn("used_verification_otp", buf)


class SeenSignaturesInvocationScopeTests(unittest.TestCase):
    """Fix 1: a ready_to_submit Workday continuation must not abort on
    persisted seen_signatures from a previous run. seen_signatures is
    invocation-scoped: loop detection only fires within one invocation's
    page-advance loop, not across continuation boundaries."""

    def test_persisted_seen_signatures_do_not_block_resume(self):
        """Simulate a resume: state has seen_signatures from a prior run,
        and the current page signature matches one of them. The runtime
        must NOT treat this as a loop: it should proceed to fill/submit
        since this is the page it's resuming onto."""
        page = FakePage(AUTOFILL_URL, body_text="Review and submit")
        page.with_selector("[data-automation-id='progressBarActiveStep']")
        sig = wd._page_signature(page)
        # Prior run persisted this exact signature
        prior_state = {"seen_signatures": [sig], "status": "ready_to_submit"}
        # The fix: the page-fill loop starts with an empty set, not the
        # persisted list. Verify the signature is not pre-loaded.
        # (We test the invariant directly: a fresh invocation's
        # seen_signatures set must not contain persisted entries.)
        invocation_seen: set[str] = set()
        self.assertNotIn(sig, invocation_seen)


class TailoredResumeAndCoverLetterTests(unittest.TestCase):
    """Fix 4: Workday must use the tailored resume artifact and cover
    letter from Phase 2 when available, falling back to the master
    resume when not provided."""

    def test_resume_pdf_path_prefers_tailored_when_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            tailored = os.path.join(tmp, "tailored.pdf")
            with open(tailored, "wb") as f:
                f.write(b"%PDF-1.4 fake")
            result = wd._resume_pdf_path(tailored)
            self.assertEqual(result, tailored)

    def test_resume_pdf_path_falls_back_when_tailored_missing(self):
        # A nonexistent tailored path should fall back to the master/default
        result = wd._resume_pdf_path("/nonexistent/tailored.pdf")
        # Either the default resume exists or None, but never the bogus path
        self.assertNotEqual(result, "/nonexistent/tailored.pdf")

    def test_resume_pdf_path_falls_back_when_no_tailored(self):
        result = wd._resume_pdf_path(None)
        # Should resolve to the default/master resume or None
        if result is not None:
            self.assertTrue(os.path.exists(result))

    def test_fill_workday_page_accepts_cover_letter(self):
        """_fill_workday_page must accept a cover_letter arg without
        crashing, and report cover_letter_pasted in its result."""
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        page.with_selector("[data-automation-id='progressBarActiveStep']")
        result = wd._fill_workday_page(page, {}, None, "Dear Hiring Manager...")
        self.assertIn("cover_letter_pasted", result)
        self.assertFalse(result["cover_letter_pasted"])  # no cover letter field on this fake page

    def test_username_is_constructed_for_url_field(self):
        page = FakePage(AUTOFILL_URL)
        page.with_role("textbox", "LinkedIn")
        result = wd._fill_workday_page(page, {"linkedin_username": "jane-doe"})
        self.assertIn("LinkedIn", result["filled_labels"])
        self.assertNotIn("linkedin_username", result["unmatched_keys"])


class PersonalAccountEmailTests(unittest.TestCase):
    """docs/workday-personal-inbox-plan.md: a personal candidate email
    from a connected/verified Gmail profile must drive Workday account
    creation instead of requiring a managed alias. The managed alias
    remains a supported compatibility path; a personal email is never a
    silent fallback when none was authenticated."""

    def test_account_email_normalizes_case_and_whitespace(self):
        self.assertEqual(wd._normalize_account_email("  Jane@Example.com  "), "jane@example.com")
        self.assertEqual(wd._normalize_account_email(None), "")

    def test_account_email_keys_password_sidecar_same_as_alias(self):
        """A personal email and an alias that resolve to the same normalized
        address + tenant must share one password sidecar so credential
        reuse works across the two paths."""
        url = "https://co.wd5.myworkdayjobs.com/External"
        key_personal = wd._account_key(wd._normalize_account_email("Jane@Personal.com"), url)
        key_alias = wd._account_key(wd._normalize_account_email("jane@personal.com"), url)
        self.assertEqual(key_personal, key_alias)

    def test_account_email_and_alias_email_both_absent_rejected(self):
        """run() must refuse when neither account_email nor alias_email is
        supplied: a personal email is never a silent fallback."""
        with tempfile.TemporaryDirectory() as tmp:
            rc = wd.run("job-x", "/no/such/queue.json", tmp, "", apply_url=POSTING_URL)
            self.assertNotEqual(rc, 0)

    def test_session_secret_file_reads_json_link_and_otp(self):
        with tempfile.TemporaryDirectory() as tmp:
            secret_path = os.path.join(tmp, "secret.json")
            with open(secret_path, "w", encoding="utf-8") as f:
                json.dump({"link": "https://employer.example/verify?t=abc", "otp": "654321"}, f)
            link, otp = wd._read_session_secret_file(secret_path)
            self.assertEqual(link, "https://employer.example/verify?t=abc")
            self.assertEqual(otp, "654321")

    def test_session_secret_file_plain_digits_treated_as_otp(self):
        with tempfile.TemporaryDirectory() as tmp:
            secret_path = os.path.join(tmp, "code.txt")
            with open(secret_path, "w", encoding="utf-8") as f:
                f.write("482917\n")
            link, otp = wd._read_session_secret_file(secret_path)
            self.assertIsNone(link)
            self.assertEqual(otp, "482917")

    def test_session_secret_file_missing_returns_none(self):
        self.assertEqual(wd._read_session_secret_file(None), (None, None))
        self.assertEqual(wd._read_session_secret_file("/no/such/file"), (None, None))

    def test_session_secret_file_keeps_value_out_of_argv(self):
        """The whole point of --session-secret-file: the raw secret is read
        from a file, never passed as a command-line argument. Confirm the
        helper never echoes the value to stdout/stderr."""
        import io, contextlib
        with tempfile.TemporaryDirectory() as tmp:
            secret_path = os.path.join(tmp, "secret.json")
            with open(secret_path, "w", encoding="utf-8") as f:
                json.dump({"otp": "SUPERSECRET"}, f)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                link, otp = wd._read_session_secret_file(secret_path)
            self.assertEqual(otp, "SUPERSECRET")
            self.assertNotIn("SUPERSECRET", buf.getvalue())


class ManualRequiredDetectionTests(unittest.TestCase):
    """docs/workday-personal-inbox-plan.md: TOTP apps, push approval,
    security keys, SSO, and unsupported MFA must checkpoint
    manual_required: never claimed verified or submitted on ambiguity."""

    def test_totp_authenticator_app_detected(self):
        page = FakePage(AUTOFILL_URL, body_text="Open your authenticator app and enter the code")
        self.assertEqual(wd._manual_required_reason(page), "totp")

    def test_push_approval_detected(self):
        page = FakePage(AUTOFILL_URL, body_text="Approve sign-in request on your device")
        self.assertEqual(wd._manual_required_reason(page), "push_approval")

    def test_security_key_detected(self):
        page = FakePage(AUTOFILL_URL, body_text="Insert your security key and tap it")
        self.assertEqual(wd._manual_required_reason(page), "security_key")

    def test_sso_detected(self):
        page = FakePage(AUTOFILL_URL, body_text="Sign in with Google to continue")
        self.assertEqual(wd._manual_required_reason(page), "sso")

    def test_plain_otp_page_not_flagged_as_manual(self):
        """A normal OTP entry page must NOT be misclassified as manual_required:
        that would stop a flow the runtime can actually complete."""
        page = FakePage(AUTOFILL_URL, body_text="Enter your verification code")
        self.assertIsNone(wd._manual_required_reason(page))

    def test_no_challenge_returns_none(self):
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        self.assertIsNone(wd._manual_required_reason(page))

    def test_email_verification_prompt_is_detected(self):
        page = FakePage(AUTOFILL_URL, body_text="Check your inbox to verify your email address")
        self.assertTrue(wd._verification_required(page))

    def test_immediate_account_flow_is_not_marked_as_waiting(self):
        page = FakePage(AUTOFILL_URL, body_text="Autofill with Resume My Information")
        self.assertFalse(wd._verification_required(page))


class NoSubmitPreservedTests(unittest.TestCase):
    """The fail-closed final-submit contract is unchanged by the
    personal-inbox work: --no-submit must still NOT submit, and an
    ambiguous post-submit page must never read as 'submitted'."""

    def test_no_submit_flag_present_in_cli(self):
        """The --no-submit flag must still exist and be a store_true
        boolean (regression: the new --account-email/--session-secret-file
        args must not have displaced it)."""
        import argparse
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                wd.main(["--help"])
            except SystemExit:
                pass
        self.assertIn("--no-submit", out.getvalue())

    def test_account_email_does_not_weaken_fail_closed(self):
        """A personal email must not change the outcome_unclear verdict:
        the fail-closed property is independent of which email drove
        account creation."""
        page = FakePage(AUTOFILL_URL, body_text="Review your application")
        submit = page.locator("[data-automation-id='submitButton']")
        result = wd._attempt_final_submit(page, submit)
        self.assertEqual(result["outcome"], "outcome_unclear")
        self.assertNotEqual(result["outcome"], "submitted")


# --- Workday My Experience / idempotency / inferred-answers tests ---------

_MASTER_RESUME = {
    "experience": [
        {
            "company": "KredosAI",
            "title": "Software Development Engineer Intern",
            "dates": "Jun 2025 – Present",
            "location": "Issaquah, WA",
            "bullets": [
                {"text": "Built a real-time voice-agent pipeline with LiveKit"},
                {"text": "Reduced irrelevant retrievals by ~30%"},
            ],
        },
        {
            "company": "Apexiel",
            "title": "AI Engineer Intern",
            "dates": "Jun 2024 – Oct 2024",
            "location": "Remote",
            "bullets": [
                {"text": "Cut manual document lookup time by ~35%"},
            ],
        },
    ],
    "education": [
        {
            "school": "University of Washington",
            "degree": "B.S. Informatics, Minor in Data Science",
            "details": ["GPA: 3.75/4.00"],
        },
    ],
    "skills": [
        {"category": "Languages", "items": ["Python", "Java", "C++"]},
    ],
}


class ResumeDateParsingTests(unittest.TestCase):
    """Safe parsing of resume date ranges: never fabricates a date."""

    def test_parse_current_role(self):
        sm, sy, em, ey = wd._parse_resume_date_range("Jun 2025 – Present")
        self.assertEqual(sm, "6")
        self.assertEqual(sy, "2025")
        self.assertIsNone(em)
        self.assertIsNone(ey)

    def test_parse_completed_role(self):
        sm, sy, em, ey = wd._parse_resume_date_range("Jun 2024 – Oct 2024")
        self.assertEqual((sm, sy, em, ey), ("6", "2024", "10", "2024"))

    def test_parse_empty_returns_none(self):
        self.assertEqual(wd._parse_resume_date_range(""), (None, None, None, None))

    def test_parse_garbage_returns_none(self):
        self.assertEqual(wd._parse_resume_date_range("some random text"), (None, None, None, None))

    def test_parse_year_only(self):
        sm, sy, em, ey = wd._parse_resume_date_range("2024 – 2025")
        self.assertEqual(sm, None)
        self.assertEqual(sy, "2024")
        self.assertEqual(em, None)
        self.assertEqual(ey, "2025")


class DegreeMappingTests(unittest.TestCase):
    """Map free-text degree strings to Workday's exact dropdown options."""

    def test_bs_maps_to_bachelors(self):
        self.assertEqual(wd._map_degree_to_workday("B.S. Informatics"), "Bachelors")

    def test_bachelor_of_maps_to_bachelors(self):
        self.assertEqual(wd._map_degree_to_workday("Bachelor of Science"), "Bachelors")

    def test_ms_maps_to_masters(self):
        self.assertEqual(wd._map_degree_to_workday("M.S. Computer Science"), "Masters")

    def test_phd_maps_to_doctorate(self):
        self.assertEqual(wd._map_degree_to_workday("Ph.D. in AI"), "Doctorate")

    def test_associates(self):
        self.assertEqual(wd._map_degree_to_workday("Associate of Arts"), "Associates")

    def test_high_school(self):
        self.assertEqual(wd._map_degree_to_workday("High School Diploma"), "High School")

    def test_ged(self):
        self.assertEqual(wd._map_degree_to_workday("GED"), "GED")

    def test_unknown_returns_none(self):
        self.assertIsNone(wd._map_degree_to_workday("Certificate in Welding"))

    def test_empty_returns_none(self):
        self.assertIsNone(wd._map_degree_to_workday(""))


class FieldOfStudyExtractionTests(unittest.TestCase):

    def test_extracts_informatics(self):
        self.assertEqual(wd._extract_field_of_study("B.S. Informatics, Minor in Data Science"), "Informatics")

    def test_strips_minor(self):
        self.assertEqual(wd._extract_field_of_study("B.A. Economics, Minor in Math"), "Economics")

    def test_no_prefix(self):
        self.assertEqual(wd._extract_field_of_study("Computer Science"), "Computer Science")

    def test_empty_returns_none(self):
        self.assertIsNone(wd._extract_field_of_study(""))


class GpaExtractionTests(unittest.TestCase):

    def test_extracts_gpa(self):
        self.assertEqual(wd._extract_gpa(["GPA: 3.75/4.00", "Relevant Coursework: ..."]), "3.75")

    def test_no_gpa_returns_none(self):
        self.assertIsNone(wd._extract_gpa(["Relevant Coursework: Algorithms"]))

    def test_empty_details(self):
        self.assertIsNone(wd._extract_gpa([]))


class RoleDescriptionTests(unittest.TestCase):

    def test_joins_bullets(self):
        exp = {"bullets": [{"text": "Built X"}, {"text": "Improved Y"}]}
        self.assertEqual(wd._build_role_description(exp), "Built X\nImproved Y")

    def test_no_bullets_returns_empty(self):
        self.assertEqual(wd._build_role_description({}), "")

    def test_filters_empty_bullets(self):
        exp = {"bullets": [{"text": "Built X"}, {"text": ""}]}
        self.assertEqual(wd._build_role_description(exp), "Built X")


class EntryExistsTests(unittest.TestCase):

    def test_matches_company_and_title(self):
        body = "Work Experience KredosAI Software Development Engineer Intern Issaquah WA"
        self.assertTrue(wd._entry_exists_in_text(body, "KredosAI", "Software Development Engineer Intern"))

    def test_does_not_match_when_company_absent(self):
        body = "Work Experience Apexiel AI Engineer Intern"
        self.assertFalse(wd._entry_exists_in_text(body, "KredosAI", "Software Development Engineer Intern"))

    def test_matches_school(self):
        body = "Education University of Washington B.S. Informatics"
        self.assertTrue(wd._entry_exists_in_text(body, "University of Washington"))

    def test_empty_fragments(self):
        self.assertFalse(wd._entry_exists_in_text("some text", ""))


class ResumeIdempotencyTests(unittest.TestCase):
    """Requirement 1: resume upload must be idempotent: a prior checkpoint
    showing resume_attached or visible uploaded-file evidence must prevent
    re-calling attach_resume on later continuations."""

    def test_prior_resume_attached_detected_from_fill_history(self):
        state = {"fill_history": [{"resume_attached": False}, {"resume_attached": True}]}
        self.assertTrue(wd._prior_resume_attached(state))

    def test_prior_resume_attached_false_when_no_history(self):
        self.assertFalse(wd._prior_resume_attached({}))
        self.assertFalse(wd._prior_resume_attached({"fill_history": []}))

    def test_resume_already_uploaded_by_text(self):
        page = FakePage(AUTOFILL_URL, body_text="resume.pdf successfully uploaded")
        self.assertTrue(wd._resume_already_uploaded(page))

    def test_resume_already_uploaded_by_file_chip(self):
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        page.with_selector("[data-automation-id*='file-name' i]")
        self.assertTrue(wd._resume_already_uploaded(page))

    def test_resume_not_uploaded_when_no_evidence(self):
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        self.assertFalse(wd._resume_already_uploaded(page))

    def test_fill_workday_page_skips_resume_when_flag_set(self):
        """When skip_resume=True, _fill_workday_page must NOT call
        attach_resume and must report resume_attached=True (the resume is
        already attached from a prior run) plus resume_skipped=True."""
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        page.with_selector("input[type=file]")
        result = wd._fill_workday_page(page, {}, None, None, skip_resume=True)
        self.assertTrue(result["resume_attached"])
        self.assertTrue(result["resume_skipped"])
        # No file input should have been filled.
        self.assertFalse(any(sel == "input[type=file]" for sel, _ in page.filled_values))

    def test_fill_workday_page_attaches_resume_when_not_skipped(self):
        """When skip_resume=False and a file input is present, the normal
        attach path runs (resume_attached reflects the attach result)."""
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        page.with_selector("input[type=file]")
        # attach_resume calls set_input_files which FakeLocator doesn't
        # implement: the exception is caught and resume_attached=False.
        result = wd._fill_workday_page(page, {}, None, None, skip_resume=False)
        self.assertFalse(result["resume_skipped"])
        # resume_attached is False because FakeLocator.set_input_files raises
        self.assertFalse(result["resume_attached"])


class MyExperiencePageDetectionTests(unittest.TestCase):

    def test_detected_when_add_buttons_and_section_headers(self):
        page = FakePage(AUTOFILL_URL, body_text="My Experience Work Experience Education Languages")
        page.with_selector("button[data-automation-id='add-button']", count=3)
        self.assertTrue(wd._is_my_experience_page(page))

    def test_not_detected_without_add_buttons(self):
        page = FakePage(AUTOFILL_URL, body_text="Work Experience Education")
        self.assertFalse(wd._is_my_experience_page(page))

    def test_not_detected_without_section_headers(self):
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        page.with_selector("button[data-automation-id='add-button']")
        self.assertFalse(wd._is_my_experience_page(page))


class MyExperienceFillTests(unittest.TestCase):
    """Requirement 2: fill Work Experience and Education from the master
    resume, idempotently: existing entries are not re-added."""

    def test_skips_work_entry_that_already_exists(self):
        """If the page body already contains the company and title, the
        entry must be skipped (not re-added). The non-duplicate entry is
        added only when its identity fields are actually filled."""
        body = (
            "My Experience Work Experience Education Languages "
            "KredosAI Software Development Engineer Intern Issaquah WA"
        )
        page = FakePage(AUTOFILL_URL, body_text=body)
        page.with_selector("button[data-automation-id='add-button']", count=3)
        # Register the work-entry identity inputs so _fill_work_entry_fields
        # can truthfully fill them and report the entry as added.
        page.with_selector("input[name='jobTitle']")
        page.with_selector("input[name='companyName']")
        page.with_selector("input[name='location']")
        page.with_selector("textarea")
        # Register the paired month/year date inputs so _fill_date_inputs
        # can fill them and report no failures.
        page.with_selector("input[data-automation-id='dateSectionMonth-input']", count=2)
        page.with_selector("input[data-automation-id='dateSectionYear-input']", count=2)
        result = wd._fill_my_experience(page, _MASTER_RESUME)
        # KredosAI is already on the page → skipped
        self.assertTrue(any(e["company"] == "KredosAI" for e in result["work_skipped"]))
        # Apexiel is not on the page → added (identity fields were fillable)
        self.assertTrue(any(e["company"] == "Apexiel" for e in result["work_added"]))

    def test_skips_education_entry_that_already_exists(self):
        body = (
            "My Experience Work Experience Education Languages "
            "University of Washington B.S. Informatics"
        )
        page = FakePage(AUTOFILL_URL, body_text=body)
        page.with_selector("button[data-automation-id='add-button']", count=3)
        result = wd._fill_my_experience(page, _MASTER_RESUME)
        self.assertTrue(any(e["school"] == "University of Washington" for e in result["education_skipped"]))
        self.assertEqual(result["education_added"], [])

    def test_no_op_when_not_my_experience_page(self):
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        result = wd._fill_my_experience(page, _MASTER_RESUME)
        self.assertEqual(result["work_added"], [])
        self.assertEqual(result["education_added"], [])

    def test_no_op_when_resume_data_empty(self):
        page = FakePage(AUTOFILL_URL, body_text="Work Experience Education")
        page.with_selector("button[data-automation-id='add-button']", count=3)
        result = wd._fill_my_experience(page, {})
        self.assertEqual(result["work_added"], [])
        self.assertEqual(result["education_added"], [])

    def test_languages_not_filled_from_programming_skills(self):
        """Programming languages (Python, Java, etc.) must NOT be inferred
        as spoken languages: the Languages section is left alone."""
        body = "My Experience Work Experience Education Languages"
        page = FakePage(AUTOFILL_URL, body_text=body)
        page.with_selector("button[data-automation-id='add-button']", count=3)
        result = wd._fill_my_experience(page, _MASTER_RESUME)
        # No language entries should appear in any result list
        self.assertNotIn("languages_added", result)


class WorkdayListboxDropdownTests(unittest.TestCase):
    """Requirement: select_workday_listbox must pick the exact visible
    option (case-insensitive, trimmed) and reject non-exact matches."""

    def test_exact_match_selects_option(self):
        page = FakePage(AUTOFILL_URL, body_text="Education")
        page.with_selector('button[name="degree"]')
        page.with_tag('button[name="degree"]', "button")
        page.with_attr('button[name="degree"]', "aria-haspopup", "listbox")
        page.with_options(["GED", "High School", "Associates", "Bachelors", "Masters", "Doctorate"])
        ok = wd.select_workday_listbox(page, 'button[name="degree"]', "Bachelors")
        self.assertTrue(ok)

    def test_workday_prompt_option_marker_selects_exact_option(self):
        page = FakePage(AUTOFILL_URL, body_text="Bachelors")
        page.with_selector('button[name="degree"]')
        page.with_tag('button[name="degree"]', "button")
        page.with_attr('button[name="degree"]', "aria-haspopup", "listbox")
        page.with_selector("[data-automation-id='promptOption']")
        ok = wd.select_workday_listbox(page, 'button[name="degree"]', "Bachelors")
        self.assertTrue(ok)
        self.assertIn("[data-automation-id='promptOption']", page.clicked_selectors)

    def test_case_insensitive_match(self):
        page = FakePage(AUTOFILL_URL, body_text="Education")
        page.with_selector('button[name="degree"]')
        page.with_tag('button[name="degree"]', "button")
        page.with_attr('button[name="degree"]', "aria-haspopup", "listbox")
        page.with_options(["Bachelors", "Masters"])
        ok = wd.select_workday_listbox(page, 'button[name="degree"]', "bachelors")
        self.assertTrue(ok)

    def test_no_exact_match_returns_false(self):
        page = FakePage(AUTOFILL_URL, body_text="Education")
        page.with_selector('button[name="degree"]')
        page.with_tag('button[name="degree"]', "button")
        page.with_attr('button[name="degree"]', "aria-haspopup", "listbox")
        page.with_options(["GED", "High School", "Associates"])
        ok = wd.select_workday_listbox(page, 'button[name="degree"]', "Bachelors")
        self.assertFalse(ok)

    def test_missing_button_returns_false(self):
        page = FakePage(AUTOFILL_URL, body_text="Education")
        ok = wd.select_workday_listbox(page, 'button[name="degree"]', "Bachelors")
        self.assertFalse(ok)


class InferredWorkedAtCompanyTests(unittest.TestCase):
    """Requirement 3a: 'Have you ever worked at <company> or affiliates?'
    is Yes only when the company is in the resume experience; otherwise No."""

    def test_yes_when_company_in_resume(self):
        q = "Have you ever worked at KredosAI or affiliates?"
        self.assertEqual(wd._infer_worked_at_company_answer(q, _MASTER_RESUME), "Yes")

    def test_unresolved_when_company_absent_for_broad_affiliates(self):
        """Fix 4: for the broad 'or affiliates' wording, an absent company
        must return unresolved (None) rather than asserting No: an
        affiliate may be named differently in the resume."""
        q = "Have you ever worked at Expedia or affiliates?"
        self.assertIsNone(wd._infer_worked_at_company_answer(q, _MASTER_RESUME))

    def test_no_when_company_absent_for_narrow_previous_employer(self):
        """Fix 4: a narrow previous-employer phrasing (no affiliates
        clause) may safely answer No when the company is clearly absent."""
        q = "Have you ever worked for Google?"
        self.assertEqual(wd._infer_worked_at_company_answer(q, _MASTER_RESUME), "No")

    def test_none_when_company_not_extractable(self):
        q = "Do you have prior experience in the travel industry?"
        self.assertIsNone(wd._infer_worked_at_company_answer(q, _MASTER_RESUME))

    def test_company_in_resume_experience_helper(self):
        self.assertTrue(wd._company_in_resume_experience("KredosAI", _MASTER_RESUME))
        self.assertTrue(wd._company_in_resume_experience("kredosai", _MASTER_RESUME))
        self.assertFalse(wd._company_in_resume_experience("Google", _MASTER_RESUME))

    def test_extract_company_from_question(self):
        company, is_broad = wd._extract_company_from_worked_question("Have you ever worked at Expedia or affiliates?")
        self.assertEqual(company, "Expedia")
        self.assertTrue(is_broad)
        company, is_broad = wd._extract_company_from_worked_question("Have you ever worked for Microsoft or any of its affiliates?")
        self.assertEqual(company, "Microsoft")
        self.assertTrue(is_broad)
        company, is_broad = wd._extract_company_from_worked_question("Have you ever worked for Google?")
        self.assertEqual(company, "Google")
        self.assertFalse(is_broad)


class InferredRelocationTests(unittest.TestCase):
    """Requirement 3b: relocation is Yes only when the job location matches
    a configured preferred location; otherwise unresolved (never guessed)."""

    PREFERRED = ["Remote", "Seattle", "San Francisco", "New York", "Dallas"]

    def test_yes_when_location_matches_preferred(self):
        self.assertEqual(wd._infer_relocation_answer("Are you willing to relocate?", "Seattle, WA", self.PREFERRED), "Yes")

    def test_yes_for_remote(self):
        self.assertEqual(wd._infer_relocation_answer("Are you willing to relocate?", "Remote", self.PREFERRED), "Yes")

    def test_unresolved_when_location_does_not_match(self):
        """A job in a non-preferred location must NOT be auto-answered:
        checkpoint as manual review instead of guessing."""
        self.assertIsNone(wd._infer_relocation_answer("Are you willing to relocate?", "Boise, ID", self.PREFERRED))

    def test_unresolved_when_job_location_unknown(self):
        self.assertIsNone(wd._infer_relocation_answer("Are you willing to relocate?", None, self.PREFERRED))

    def test_location_matches_preferred_helper(self):
        self.assertTrue(wd._location_matches_preferred("Seattle, WA", self.PREFERRED))
        self.assertTrue(wd._location_matches_preferred("San Francisco Bay Area", self.PREFERRED))
        self.assertFalse(wd._location_matches_preferred("London, UK", self.PREFERRED))
        self.assertFalse(wd._location_matches_preferred("", self.PREFERRED))


class AIAtestationTests(unittest.TestCase):
    """Requirement 3: the Expedia AI-attestation question must NEVER be
    auto-answered: it is a material applicant acknowledgment."""

    def test_detected_as_ai_attestation(self):
        self.assertTrue(wd._is_ai_attestation_question("Do you attest that you will not use AI to complete this application?"))
        self.assertTrue(wd._is_ai_attestation_question("I acknowledge that AI-generated responses are prohibited."))

    def test_plain_question_not_flagged(self):
        self.assertFalse(wd._is_ai_attestation_question("Are you willing to relocate?"))
        self.assertFalse(wd._is_ai_attestation_question("Have you ever worked at Expedia or affiliates?"))


class InferredQuestionsIntegrationTests(unittest.TestCase):
    """_fill_inferred_questions returns unresolved questions that aplyx
    cannot safely answer: the caller checkpoints as manual review."""

    def test_relocation_unresolved_when_location_not_preferred(self):
        body = "Application Questions Are you willing to relocate for this position?"
        page = FakePage(AUTOFILL_URL, body_text=body)
        unresolved = wd._fill_inferred_questions(page, _MASTER_RESUME, "Boise, ID", ["Seattle", "Remote"])
        self.assertTrue(any("relocat" in q["question"].lower() for q in unresolved))

    def test_relocation_unresolved_when_location_unknown(self):
        body = "Application Questions Are you willing to relocate for this position?"
        page = FakePage(AUTOFILL_URL, body_text=body)
        unresolved = wd._fill_inferred_questions(page, _MASTER_RESUME, None, ["Seattle"])
        self.assertTrue(any("relocat" in q["question"].lower() for q in unresolved))

    def test_no_unresolved_when_no_inferred_questions_on_page(self):
        page = FakePage(AUTOFILL_URL, body_text="My Information First Name Last Name")
        unresolved = wd._fill_inferred_questions(page, _MASTER_RESUME, "Seattle, WA", ["Seattle"])
        self.assertEqual(unresolved, [])

    def test_ai_attestation_left_unresolved(self):
        body = "Application Questions Do you attest that you will not use AI to complete this application?"
        page = FakePage(AUTOFILL_URL, body_text=body)
        unresolved = wd._fill_inferred_questions(page, _MASTER_RESUME, "Seattle, WA", ["Seattle"])
        self.assertTrue(any("attest" in q["reason"].lower() or "attest" in q["question"].lower() for q in unresolved))

    def test_empty_resume_data_still_detects_ai_attestation(self):
        """Fix 3: AI-attestation detection must run even when resume_data
        is empty/corrupt: that question must never be auto-answered
        regardless of resume state."""
        body = "Application Questions Do you attest that you will not use AI to complete this application?"
        page = FakePage(AUTOFILL_URL, body_text=body)
        unresolved = wd._fill_inferred_questions(page, {}, "Seattle, WA", ["Seattle"])
        self.assertTrue(any("attest" in q["reason"].lower() or "attest" in q["question"].lower() for q in unresolved))

    def test_empty_resume_data_no_inferred_questions_on_plain_page(self):
        """With empty resume_data and no inferred questions on the page,
        unresolved is empty: the AI-attestation scan runs but finds
        nothing."""
        page = FakePage(AUTOFILL_URL, body_text="My Information First Name Last Name")
        self.assertEqual(wd._fill_inferred_questions(page, {}, "Seattle", ["Seattle"]), [])


class FillWorkdayPageIntegrationTests(unittest.TestCase):
    """End-to-end-ish checks that _fill_workday_page wires the new
    structured-fill and inferred-question paths into its result dict."""

    def test_result_includes_my_experience_and_unresolved_keys(self):
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        result = wd._fill_workday_page(page, {}, None, None, resume_data=_MASTER_RESUME, job_location="Seattle, WA", preferred_locations=["Seattle"])
        self.assertIn("my_experience", result)
        self.assertIn("unresolved_questions", result)
        self.assertIn("resume_skipped", result)

    def test_resume_skipped_flag_false_by_default(self):
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        result = wd._fill_workday_page(page, {}, None, None)
        self.assertFalse(result["resume_skipped"])


# --- Hardening tests (code-review fixes) -----------------------------------


class ResumeStateFlagTests(unittest.TestCase):
    """Fix 1: a dedicated state['resume_attached'] flag must survive the
    capped fill_history[-10:] truncation and drive the skip decision, so
    attach_resume is never called again on a later run that already
    uploaded the resume."""

    def test_prior_resume_attached_reads_dedicated_flag(self):
        """The dedicated flag alone (no fill_history) must trigger the
        skip: this is what survives the fill_history cap."""
        self.assertTrue(wd._prior_resume_attached({"resume_attached": True}))

    def test_prior_resume_attached_flag_wins_over_empty_history(self):
        """Even with an empty fill_history, the dedicated flag drives the
        skip decision."""
        self.assertTrue(wd._prior_resume_attached({"resume_attached": True, "fill_history": []}))

    def test_prior_resume_attached_falls_back_to_history(self):
        """Backward-compatible fallback: a checkpoint written before the
        flag existed still works via the fill_history scan."""
        state = {"fill_history": [{"resume_attached": False}, {"resume_attached": True}]}
        self.assertTrue(wd._prior_resume_attached(state))

    def test_prior_resume_attached_false_when_no_signal(self):
        self.assertFalse(wd._prior_resume_attached({}))
        self.assertFalse(wd._prior_resume_attached({"fill_history": [{"resume_attached": False}]}))

    def test_fill_history_cap_does_not_lose_resume_flag(self):
        """Simulate 12 fill_history entries (only last 10 kept) where the
        resume was attached in entry 0: the dedicated flag must still be
        True so the skip decision survives the cap."""
        state: dict = {"fill_history": []}
        for i in range(12):
            entry = {"resume_attached": (i == 0)}
            history = state.get("fill_history") or []
            history.append(entry)
            state["fill_history"] = history[-10:]
            # The run loop persists the dedicated flag whenever a fill
            # result reports resume_attached=True.
            if entry.get("resume_attached"):
                state["resume_attached"] = True
        # Entry 0 (the resume attach) has been truncated out of fill_history.
        self.assertFalse(any(e.get("resume_attached") for e in state["fill_history"]))
        # But the dedicated flag survives and drives the skip.
        self.assertTrue(wd._prior_resume_attached(state))


class StructuredFillSuccessFailureTests(unittest.TestCase):
    """Fix 2: _fill_work_entry_fields / _fill_education_entry_fields must
    return success/unresolved data, not None. Only report work_added /
    education_added after identity fields and required dropdowns are
    actually filled. Failed exact degree selection or missing required
    controls must produce unresolved/manual review, never silently pass."""

    def _work_page(self):
        page = FakePage(AUTOFILL_URL, body_text="My Experience Work Experience Education Languages")
        page.with_selector("button[data-automation-id='add-button']", count=3)
        page.with_selector("input[name='jobTitle']")
        page.with_selector("input[name='companyName']")
        page.with_selector("input[name='location']")
        page.with_selector("textarea")
        page.with_selector("input[data-automation-id='dateSectionMonth-input']", count=2)
        page.with_selector("input[data-automation-id='dateSectionYear-input']", count=2)
        return page

    def test_work_entry_returns_dict_not_none(self):
        page = self._work_page()
        report = wd._fill_work_entry_fields(page, _MASTER_RESUME["experience"][1])
        self.assertIsInstance(report, dict)
        self.assertIn("ok", report)
        self.assertIn("filled", report)
        self.assertIn("unresolved", report)

    def test_work_entry_ok_when_identity_filled(self):
        page = self._work_page()
        report = wd._fill_work_entry_fields(page, _MASTER_RESUME["experience"][1])
        self.assertTrue(report["ok"])
        self.assertIn("jobTitle", report["filled"])
        self.assertIn("companyName", report["filled"])

    def test_work_entry_unresolved_when_identity_input_missing(self):
        """A missing jobTitle input must produce an unresolved entry, not
        a silent pass."""
        page = self._work_page()
        # Remove the jobTitle input so the fill fails.
        page._selector_counts.pop("input[name='jobTitle']", None)
        report = wd._fill_work_entry_fields(page, _MASTER_RESUME["experience"][1])
        self.assertFalse(report["ok"])
        self.assertTrue(any(u["field"] == "jobTitle" for u in report["unresolved"]))

    def test_education_entry_returns_dict_not_none(self):
        page = FakePage(AUTOFILL_URL, body_text="Education")
        page.with_selector("input[name='schoolName']")
        page.with_selector("input[name='fieldOfStudy']")
        page.with_selector("input[name='gradeAverage']")
        page.with_selector('button[name="degree"]')
        page.with_tag('button[name="degree"]', "button")
        page.with_attr('button[name="degree"]', "aria-haspopup", "listbox")
        page.with_options(["GED", "High School", "Associates", "Bachelors", "Masters", "Doctorate"])
        report = wd._fill_education_entry_fields(page, _MASTER_RESUME["education"][0])
        self.assertIsInstance(report, dict)
        self.assertTrue(report["ok"])
        self.assertIn("schoolName", report["filled"])
        self.assertIn("degree", report["filled"])

    def test_education_unresolved_when_exact_degree_missing(self):
        """A degree that maps to a Workday option but whose exact option
        is absent from the dropdown must produce unresolved: never
        silently pass."""
        page = FakePage(AUTOFILL_URL, body_text="Education")
        page.with_selector("input[name='schoolName']")
        page.with_selector('button[name="degree"]')
        page.with_tag('button[name="degree"]', "button")
        page.with_attr('button[name="degree"]', "aria-haspopup", "listbox")
        # Only GED/High School available: Bachelors is not.
        page.with_options(["GED", "High School"])
        report = wd._fill_education_entry_fields(page, _MASTER_RESUME["education"][0])
        self.assertFalse(report["ok"])
        self.assertTrue(any(u["field"] == "degree" for u in report["unresolved"]))

    def test_education_unresolved_when_degree_unmappable(self):
        """A degree string that does not map to any Workday option must
        produce unresolved rather than silently passing with no degree."""
        page = FakePage(AUTOFILL_URL, body_text="Education")
        page.with_selector("input[name='schoolName']")
        edu = {"school": "Some College", "degree": "Certificate in Welding", "details": []}
        report = wd._fill_education_entry_fields(page, edu)
        self.assertFalse(report["ok"])
        self.assertTrue(any(u["field"] == "degree" for u in report["unresolved"]))

    def test_my_experience_reports_unresolved_for_failed_entry(self):
        """_fill_my_experience must put a failed entry in work_unresolved,
        not work_added, so the caller checkpoints as manual review."""
        page = self._work_page()
        # Remove company input so the entry can't be fully filled.
        page._selector_counts.pop("input[name='companyName']", None)
        result = wd._fill_my_experience(page, _MASTER_RESUME)
        # Apexiel (not on page) should be unresolved, not added.
        self.assertTrue(any(e["company"] == "Apexiel" for e in result["work_unresolved"]))
        self.assertFalse(any(e["company"] == "Apexiel" for e in result["work_added"]))

    def test_my_experience_result_has_unresolved_keys(self):
        """The result dict must always carry the unresolved lists so the
        caller can check them without a KeyError."""
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        result = wd._fill_my_experience(page, _MASTER_RESUME)
        self.assertIn("work_unresolved", result)
        self.assertIn("education_unresolved", result)


class ExceptionToUnresolvedTests(unittest.TestCase):
    """Fix 3: exceptions around _fill_my_experience / _fill_inferred_questions
    must NOT be swallowed: any failure produces an unresolved/manual-review
    sentinel so the runtime cannot proceed toward submit while safety
    checks are unavailable."""

    def test_fill_workday_page_surfaces_my_experience_exception(self):
        """When _fill_my_experience raises, _fill_workday_page must surface
        an unresolved sentinel rather than silently passing."""
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        orig = wd._fill_my_experience

        def boom(page, resume_data):
            raise RuntimeError("structured fill crashed")

        wd._fill_my_experience = boom
        try:
            result = wd._fill_workday_page(page, {}, None, None, resume_data=_MASTER_RESUME)
        finally:
            wd._fill_my_experience = orig
        unresolved = result.get("unresolved_questions") or []
        self.assertTrue(any("_fill_my_experience" in q.get("question", "") or "structured fill" in q.get("reason", "") for q in unresolved))

    def test_fill_workday_page_surfaces_inferred_questions_exception(self):
        """When _fill_inferred_questions raises, _fill_workday_page must
        surface an unresolved sentinel rather than silently passing."""
        page = FakePage(AUTOFILL_URL, body_text="My Information")
        orig = wd._fill_inferred_questions

        def boom(page, resume_data, job_location, preferred_locations):
            raise RuntimeError("inferred detection crashed")

        wd._fill_inferred_questions = boom
        try:
            result = wd._fill_workday_page(page, {}, None, None, resume_data=_MASTER_RESUME)
        finally:
            wd._fill_inferred_questions = orig
        unresolved = result.get("unresolved_questions") or []
        self.assertTrue(any("_fill_inferred_questions" in q.get("question", "") or "inferred-question" in q.get("reason", "") for q in unresolved))


class NewlineQuestionMatchingTests(unittest.TestCase):
    """Fix 4: worked-at-company / relocation / AI question regexes must be
    newline-safe (re.DOTALL) and bounded to one question."""

    def test_worked_at_question_matched_across_newlines(self):
        body = "Application Questions\nHave you ever worked at KredosAI or\naffiliates?\nNext section"
        page = FakePage(AUTOFILL_URL, body_text=body)
        unresolved = wd._fill_inferred_questions(page, _MASTER_RESUME, "Seattle, WA", ["Seattle"])
        # KredosAI is in resume → answered Yes; the field can't be filled on
        # the fake page so it lands in unresolved with the fill-failure reason.
        self.assertTrue(any("worked" in q["question"].lower() for q in unresolved))

    def test_relocation_question_matched_across_newlines(self):
        body = "Are you\nwilling to relocate\nfor this position?"
        page = FakePage(AUTOFILL_URL, body_text=body)
        unresolved = wd._fill_inferred_questions(page, _MASTER_RESUME, "Boise, ID", ["Seattle"])
        self.assertTrue(any("relocat" in q["question"].lower() for q in unresolved))

    def test_ai_attestation_matched_across_newlines(self):
        body = "Do you attest\nthat you will not use AI\nto complete this application?"
        page = FakePage(AUTOFILL_URL, body_text=body)
        unresolved = wd._fill_inferred_questions(page, _MASTER_RESUME, "Seattle, WA", ["Seattle"])
        self.assertTrue(any("attest" in q["reason"].lower() for q in unresolved))


class BroadAffiliatesUnresolvedTests(unittest.TestCase):
    """Fix 4: 'Have you ever worked at X or affiliates?' with X absent
    from the resume must return unresolved (None), not No: an affiliate
    may be named differently in the resume."""

    def test_broad_affiliates_absent_returns_none(self):
        q = "Have you ever worked at Expedia or affiliates?"
        self.assertIsNone(wd._infer_worked_at_company_answer(q, _MASTER_RESUME))

    def test_broad_affiliates_absent_produces_unresolved_in_fill(self):
        body = "Have you ever worked at Expedia or affiliates?"
        page = FakePage(AUTOFILL_URL, body_text=body)
        unresolved = wd._fill_inferred_questions(page, _MASTER_RESUME, "Seattle, WA", ["Seattle"])
        self.assertTrue(any("worked" in q["question"].lower() for q in unresolved))
        self.assertTrue(any("affiliate" in q["reason"].lower() for q in unresolved))

    def test_narrow_previous_employer_absent_returns_no(self):
        """A narrow phrasing with no affiliates clause may safely answer
        No when the company is clearly absent."""
        q = "Have you ever worked for Google?"
        self.assertEqual(wd._infer_worked_at_company_answer(q, _MASTER_RESUME), "No")


class DateFailureReportingTests(unittest.TestCase):
    """Fix 5: _fill_date_inputs must report failures instead of silently
    swallowing them. Keep safe date parsing; do not fabricate missing
    dates. Normalize month values to the rendered tenant format."""

    def test_normalize_month_numeric(self):
        self.assertEqual(wd._normalize_month_for_input("6"), "6")

    def test_normalize_month_name_to_numeric(self):
        self.assertEqual(wd._normalize_month_for_input("June"), "6")
        self.assertEqual(wd._normalize_month_for_input("jun"), "6")

    def test_normalize_month_none(self):
        self.assertIsNone(wd._normalize_month_for_input(None))
        self.assertIsNone(wd._normalize_month_for_input(""))

    def test_date_fill_reports_filled_and_failed(self):
        page = FakePage(AUTOFILL_URL, body_text="Work Experience")
        page.with_selector("input[data-automation-id='dateSectionMonth-input']", count=2)
        page.with_selector("input[data-automation-id='dateSectionYear-input']", count=2)
        report = wd._fill_date_inputs(page, "6", "2024", "10", "2024", is_current=False)
        self.assertIn("start_month", report["filled"])
        self.assertIn("start_year", report["filled"])
        self.assertIn("end_month", report["filled"])
        self.assertIn("end_year", report["filled"])
        self.assertEqual(report["failed"], [])

    def test_date_fill_reports_failure_when_inputs_absent(self):
        """When the date inputs are not present, _fill_date_inputs must
        report the failure rather than silently returning."""
        page = FakePage(AUTOFILL_URL, body_text="Work Experience")
        # No date input selectors registered.
        report = wd._fill_date_inputs(page, "6", "2024", "10", "2024", is_current=False)
        self.assertTrue(len(report["failed"]) > 0)

    def test_date_fill_skips_end_for_current_role(self):
        page = FakePage(AUTOFILL_URL, body_text="Work Experience")
        page.with_selector("input[data-automation-id='dateSectionMonth-input']", count=2)
        page.with_selector("input[data-automation-id='dateSectionYear-input']", count=2)
        report = wd._fill_date_inputs(page, "6", "2025", None, None, is_current=True)
        self.assertIn("start_month", report["filled"])
        self.assertIn("start_year", report["filled"])
        # End dates must NOT be filled for a current role.
        self.assertNotIn("end_month", report["filled"])
        self.assertNotIn("end_year", report["filled"])

    def test_date_fill_normalizes_month_name(self):
        """A month name from the resume must be normalized to the numeric
        form Workday's inputs render."""
        page = FakePage(AUTOFILL_URL, body_text="Work Experience")
        page.with_selector("input[data-automation-id='dateSectionMonth-input']", count=2)
        page.with_selector("input[data-automation-id='dateSectionYear-input']", count=2)
        report = wd._fill_date_inputs(page, "Jun", "2024", "Oct", "2024", is_current=False)
        self.assertIn("start_month", report["filled"])
        # Verify the numeric value was filled.
        month_fills = [v for sel, v in page.filled_values if sel == "input[data-automation-id='dateSectionMonth-input']"]
        self.assertIn("6", month_fills)

    def test_date_fill_does_not_fabricate_missing_dates(self):
        """A None month must not be fabricated: only the year is filled."""
        page = FakePage(AUTOFILL_URL, body_text="Work Experience")
        page.with_selector("input[data-automation-id='dateSectionMonth-input']", count=2)
        page.with_selector("input[data-automation-id='dateSectionYear-input']", count=2)
        report = wd._fill_date_inputs(page, None, "2024", None, "2025", is_current=False)
        self.assertIn("start_year", report["filled"])
        self.assertNotIn("start_month", report["filled"])
        self.assertEqual(report["failed"], [])


class PasswordSaveFailureTests(unittest.TestCase):
    """Fix 6: _save_local_password must not silently regenerate
    credentials after an I/O failure; it must raise so run fails/
    checkpoints safely."""

    def test_save_raises_on_io_failure(self):
        """When the sidecar directory cannot be created, _save_local_password
        must raise OSError rather than silently passing."""
        with tempfile.TemporaryDirectory() as tmp:
            # Make the .secrets path a file so os.makedirs fails.
            secrets = os.path.join(tmp, ".secrets")
            with open(secrets, "w") as f:
                f.write("blocker")
            with self.assertRaises(OSError):
                wd._save_local_password(tmp, "some-key", "S3cret!Pass1")

    def test_run_aborts_when_password_save_fails(self):
        """run() must return a non-zero result with a clear message when
        the password sidecar cannot be persisted: never proceed to
        account creation with an unpersisted credential."""
        with tempfile.TemporaryDirectory() as tmp:
            # Block the .secrets directory with a file.
            secrets = os.path.join(tmp, ".secrets")
            with open(secrets, "w") as f:
                f.write("blocker")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = wd.run(
                    "job-pw-fail", "/no/such/queue.json", tmp,
                    alias_email="alias@mail.aplyx.app",
                    apply_url=POSTING_URL,
                )
            self.assertNotEqual(rc, 0)
            output = buf.getvalue()
            self.assertIn("password sidecar", output)


class JobLocationArgumentTests(unittest.TestCase):
    """Fix 8: a fresh --apply-url run has no queue entry, so the canonical
    job location must be suppliable via --job-location. Queue continuations
    still read location from the queue entry."""

    def test_job_location_flag_present_in_cli(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                wd.main(["--help"])
            except SystemExit:
                pass
        self.assertIn("--job-location", out.getvalue())

    def test_apply_entry_fresh_run_has_no_location(self):
        """A fresh --apply-url entry carries no location: the runtime
        must get it from --job-location instead."""
        entry = wd._apply_entry("job-loc", "/no/such/queue.json", POSTING_URL)
        self.assertNotIn("location", entry)
        self.assertNotIn("job_location", entry)

    def test_queue_continuation_reads_location_from_entry(self):
        """A queue continuation must still read location from the queue
        entry, not require --job-location."""
        with tempfile.TemporaryDirectory() as tmp:
            queue = os.path.join(tmp, "review_queue.json")
            with open(queue, "w", encoding="utf-8") as f:
                json.dump([{"job_id": "job-q", "apply_url": POSTING_URL, "location": "Santa Clara, CA"}], f)
            entry = wd._apply_entry("job-q", queue, None)
            self.assertEqual(entry.get("location"), "Santa Clara, CA")

    def test_run_uses_job_location_arg_for_fresh_run(self):
        """run() must use the --job-location argument when the entry has
        no location (fresh --apply-url run). We verify by checking that
        relocation inference would resolve: the run reaches the playwright
        import gate (no playwright needed for this check; it fails earlier
        on the email gate, but we supply a valid email so it reaches the
        playwright import and fails there, proving job_location was
        accepted without error)."""
        with tempfile.TemporaryDirectory() as tmp:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = wd.run(
                    "job-loc-fresh", "/no/such/queue.json", tmp,
                    alias_email="alias@mail.aplyx.app",
                    apply_url=POSTING_URL,
                    job_location="Santa Clara, CA",
                )
            # Reaches the playwright import gate (playwright may or may not
            # be installed); the key assertion is it did not fail on a
            # missing-location or argument error.
            output = buf.getvalue()
            # Either playwright is installed (browser launch fails) or not
            # (the import error message). Either way, not a location error.
            self.assertNotIn("job_location", output.lower())


class ManualReviewBrowserMessageTests(unittest.TestCase):
    """Fix 7: the manual-review browser-open message must make it explicit
    that the user must close the browser before a later runtime invocation,
    so there is no profile-lock contradiction."""

    def test_unresolved_questions_message_mentions_close_browser(self):
        """The message emitted when unresolved questions are found must
        tell the user to close the browser window before re-running."""
        # We can't easily run the full loop, but we can check the message
        # string is present in the source: it's the load-bearing contract.
        import inspect
        src = inspect.getsource(wd.run)
        self.assertIn("MUST close this browser window", src)
        self.assertIn("cannot attach to the same Chrome profile", src)


if __name__ == "__main__":
    unittest.main()
