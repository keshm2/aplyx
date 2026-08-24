#!/usr/bin/env python3
"""Deterministic unit tests for the NVIDIA Workday application-flow fix in
approve_submit_workday.py. Uses a fake Playwright page — no browser, no
network, no real application is ever submitted.

Run: python3 -m unittest src.scripts.runtime.test_approve_submit_workday
or: python3 src/scripts/runtime/test_approve_submit_workday.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
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
        # This fixture doesn't model distinct per-index text — every
        # matched element shares the page's single _body_text, same
        # simplification the rest of FakePage already makes.
        return self

    def click(self, timeout: int = 2000) -> None:
        self._page._clicks.append(self._selector)

    def fill(self, value: str) -> None:
        self._page._fills.append((self._selector, value))

    def inner_text(self, timeout: int = 1000) -> str:
        return self._page._body_text


class FakeRoleLocator(FakeLocator):
    """Locator returned by `get_by_role`. Matches when the page has a
    registered role+name control. The selector string is synthetic and only
    used for click recording."""

    def __init__(self, page: "FakePage", role: str, name: str, exact: bool):
        super().__init__(page, f"role:{role}:{name}:{exact}")
        self._role = role
        self._name = name
        self._exact = exact

    def count(self) -> int:
        key = (self._role, self._name.lower(), self._exact)
        return 1 if key in self._page._role_controls else 0


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

    @property
    def clicked_selectors(self) -> list[str]:
        return list(self._clicks)


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
    branch must not fire — _submit_button returns None, so the caller never
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
    _attempt_final_submit fail closed without ever clicking submit —
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
    Workday account password out of the main state dict entirely — these
    tests cover the sidecar file it lives in instead."""

    def test_round_trips_and_is_not_world_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(wd._load_local_password(tmp, "job-1"))
            wd._save_local_password(tmp, "job-1", "S3cret!Pass1")
            self.assertEqual(wd._load_local_password(tmp, "job-1"), "S3cret!Pass1")
            path = wd._local_password_path(tmp, "job-1")
            mode = os.stat(path).st_mode & 0o777
            self.assertEqual(mode, 0o600)

    def test_missing_sidecar_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(wd._load_local_password(tmp, "no-such-job"))

    def test_password_never_lands_in_the_main_checkpoint_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd._save_local_password(tmp, "job-1", "S3cret!Pass1")
            wd._save_state(tmp, "job-1", {"job_id": "job-1", "status": "verified"})
            with open(wd._state_path(tmp, "job-1"), "r", encoding="utf-8") as fh:
                checkpoint = json.load(fh)
            self.assertNotIn("password", checkpoint)
            dumped = json.dumps(checkpoint)
            self.assertNotIn("S3cret!Pass1", dumped)


class CheckpointSanitizationTests(unittest.TestCase):
    """_save_state must strip forbidden keys even if a future code path
    adds one to the state dict directly, per Package 4's checkpoint
    exclusion list (password/OTP/cookie/session-token) — the sidecar
    file above is the primary control; this is the backstop."""

    def test_forbidden_keys_are_stripped_on_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd._save_state(tmp, "job-2", {
                "job_id": "job-2",
                "password": "leaked",
                "last_verification_otp": "654321",
                "last_verification_otp_hash": "deadbeef",
                "status": "awaiting_verification",
            })
            with open(wd._state_path(tmp, "job-2"), "r", encoding="utf-8") as fh:
                checkpoint = json.load(fh)
            self.assertNotIn("password", checkpoint)
            self.assertNotIn("last_verification_otp", checkpoint)
            self.assertEqual(checkpoint.get("last_verification_otp_hash"), "deadbeef")
            self.assertEqual(checkpoint.get("status"), "awaiting_verification")


class ValidationErrorDetectionTests(unittest.TestCase):
    """Regression coverage from a real live-site finding (2026-08-23):
    NVIDIA's Workday tenant rejects a "Save and Continue" click with
    required-question validation errors that never raise an exception
    and never navigate away — the page just stays put with inline
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
    helper (Package 4) — confirms the delegation didn't change its
    observable shape, since approve_submit_workday.py's own repeated-
    signature loop detection depends on this exact format."""

    def test_signature_combines_title_and_normalized_url(self):
        page = FakePage(AUTOFILL_URL + "?utm_source=x", body_text="Personal Information")
        page.with_selector("[data-automation-id='pageHeader']")
        self.assertEqual(wd._page_signature(page), f"Personal Information::{AUTOFILL_URL}")


class WorkdayStepTitleTests(unittest.TestCase):
    """Regression coverage from a real live-site finding (2026-08-23):
    NVIDIA's Workday tenant is a client-side-only multi-step wizard —
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


if __name__ == "__main__":
    unittest.main()
