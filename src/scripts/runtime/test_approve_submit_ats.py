#!/usr/bin/env python3
"""Deterministic unit tests for the Greenhouse / Ashby / Lever
approve-submit runtimes. Uses a scriptable fake page: no browser, no
network, no application is ever submitted.

Run: python3 -m unittest src.scripts.runtime.test_approve_submit_ats
or:  python3 src/scripts/runtime/test_approve_submit_ats.py

Focus: the pure page-inspection helpers, and above all _looks_successful,
whose old "any navigation away from the form counts as success" logic
would report an application as submitted when a failed submit merely
bounced to an SSO / error / careers page.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import approve_submit_greenhouse as gh  # noqa: E402
import approve_submit_ashby as ashby  # noqa: E402
import approve_submit_lever as lever  # noqa: E402
import browser_resilience as br  # noqa: E402


class FakeElement:
    def __init__(self, text: str = "", visible: bool = True):
        self._text = text
        self._visible = visible

    def inner_text(self, timeout: float | None = None) -> str:
        return self._text

    def is_visible(self) -> bool:
        return self._visible

    def click(self, timeout: float | None = None) -> None:
        self._clicked = True


class FakeLocator:
    def __init__(self, elements: list[FakeElement]):
        self._elements = elements

    def count(self) -> int:
        return len(self._elements)

    def nth(self, i: int) -> FakeElement:
        return self._elements[i]

    @property
    def first(self) -> FakeElement:
        return self._elements[0]

    def inner_text(self, timeout: float | None = None) -> str:
        return self._elements[0].inner_text(timeout) if self._elements else ""

    def is_visible(self) -> bool:
        return bool(self._elements) and self._elements[0].is_visible()


class FakePage:
    """Scriptable fake of the slice of Playwright's Page API these runtimes
    touch. Configure `url`, `body_text`, and a {selector-or-role-key:
    [FakeElement,...]} map; anything not configured resolves to an empty
    locator."""

    def __init__(self, url: str = "https://boards.greenhouse.io/acme/jobs/1", body_text: str = ""):
        self.url = url
        self._body_text = body_text
        self._by_selector: dict[str, list[FakeElement]] = {}
        self._by_role_name: dict[str, list[FakeElement]] = {}

    # --- configuration helpers ---
    def with_selector(self, selector: str, elements: list[FakeElement]) -> "FakePage":
        self._by_selector[selector] = elements
        return self

    def with_role_button(self, name: str, elements: list[FakeElement]) -> "FakePage":
        self._by_role_name[name.lower()] = elements
        return self

    # --- Playwright-shaped surface ---
    def locator(self, selector: str) -> FakeLocator:
        if selector == "body":
            return FakeLocator([FakeElement(self._body_text)])
        return FakeLocator(self._by_selector.get(selector, []))

    def get_by_role(self, role: str, name: str = "", exact: bool = False) -> FakeLocator:
        return FakeLocator(self._by_role_name.get(name.lower(), []))

    def get_by_label(self, *a, **k) -> FakeLocator:
        return FakeLocator([])

    def get_by_placeholder(self, *a, **k) -> FakeLocator:
        return FakeLocator([])

    def get_by_text(self, *a, **k) -> FakeLocator:
        return FakeLocator([])

    def screenshot(self, path: str, full_page: bool = False) -> None:
        if getattr(self, "_screenshot_raises", False):
            raise RuntimeError("target page/frame has been closed")
        with open(path, "wb") as fh:
            fh.write(b"\x89PNG\r\n")


# --------------------------------------------------------------------------
# _looks_like_<family>
# --------------------------------------------------------------------------
class HostMatchTests(unittest.TestCase):
    def test_greenhouse_hosts(self):
        self.assertTrue(gh._looks_like_greenhouse("https://boards.greenhouse.io/acme/jobs/1"))
        self.assertTrue(gh._looks_like_greenhouse("https://job-boards.greenhouse.io/acme/jobs/1"))
        self.assertTrue(gh._looks_like_greenhouse("https://acme.greenhouse.io/x"))
        self.assertFalse(gh._looks_like_greenhouse("https://jobs.lever.co/acme/1"))
        self.assertFalse(gh._looks_like_greenhouse("not a url"))

    def test_ashby_host_is_exact(self):
        self.assertTrue(ashby._looks_like_ashby("https://jobs.ashbyhq.com/acme/1/application"))
        self.assertFalse(ashby._looks_like_ashby("https://acme.ashbyhq.com/1"))
        self.assertFalse(ashby._looks_like_ashby("https://boards.greenhouse.io/acme"))

    def test_lever_host_is_exact(self):
        self.assertTrue(lever._looks_like_lever("https://jobs.lever.co/acme/1/apply"))
        self.assertFalse(lever._looks_like_lever("https://acme.lever.co/1"))


class GreenhouseEmbedUrlTests(unittest.TestCase):
    def test_builds_from_company_and_external_id(self):
        u = gh._embed_url({"company": "databricks", "external_job_id": "8559344002"}, "greenhouse-8559344002")
        self.assertEqual(u, "https://job-boards.greenhouse.io/embed/job_app?for=databricks&token=8559344002")

    def test_falls_back_to_job_id_prefix(self):
        u = gh._embed_url({"company": "stripe"}, "greenhouse-12345")
        self.assertEqual(u, "https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=12345")

    def test_none_without_numeric_token(self):
        self.assertIsNone(gh._embed_url({"company": "stripe"}, "jk:abc123"))

    def test_none_without_company(self):
        self.assertIsNone(gh._embed_url({}, "greenhouse-12345"))


# --------------------------------------------------------------------------
# _looks_successful  — the regression-critical helper
# --------------------------------------------------------------------------
class LooksSuccessfulTests(unittest.TestCase):
    def test_greenhouse_success_phrase_in_body(self):
        page = FakePage(url="https://boards.greenhouse.io/acme/jobs/1", body_text="Thank you for applying to Acme!")
        ok, reason = gh._looks_successful(page)
        self.assertTrue(ok)
        self.assertIn("confirmation detected", reason)

    def test_greenhouse_confirmation_url(self):
        page = FakePage(url="https://boards.greenhouse.io/acme/jobs/1/confirmation", body_text="")
        ok, _ = gh._looks_successful(page)
        self.assertTrue(ok)

    def test_greenhouse_bounce_to_sso_is_not_success(self):
        # Old logic: "/job_app" not in url -> True. This is the bug: a
        # failed submit that redirected to an unrelated login page must
        # NOT be reported as a submitted application.
        page = FakePage(url="https://login.acme.com/oauth?redirect=greenhouse", body_text="Sign in to continue")
        ok, reason = gh._looks_successful(page)
        self.assertFalse(ok)
        self.assertIn("verify manually", reason)

    def test_greenhouse_still_on_form_is_not_success(self):
        page = FakePage(url="https://boards.greenhouse.io/acme/jobs/1", body_text="First name Last name")
        ok, _ = gh._looks_successful(page)
        self.assertFalse(ok)

    def test_ashby_bounce_away_is_not_success(self):
        page = FakePage(url="https://acme.com/careers", body_text="Explore roles at Acme")
        ok, reason = ashby._looks_successful(page)
        self.assertFalse(ok)
        self.assertIn("verify manually", reason)

    def test_ashby_thanks_url_is_success(self):
        page = FakePage(url="https://jobs.ashbyhq.com/acme/1/application/thank-you", body_text="")
        ok, _ = ashby._looks_successful(page)
        self.assertTrue(ok)

    def test_lever_thanks_url_is_success(self):
        page = FakePage(url="https://jobs.lever.co/acme/1a2b3c/thanks", body_text="")
        ok, _ = lever._looks_successful(page)
        self.assertTrue(ok)

    def test_lever_bounce_away_is_not_success(self):
        page = FakePage(url="https://acme.com/error", body_text="Something went wrong")
        ok, reason = lever._looks_successful(page)
        self.assertFalse(ok)
        self.assertIn("verify manually", reason)

    def test_lever_success_phrase(self):
        page = FakePage(url="https://jobs.lever.co/acme/1/apply", body_text="Application submitted. We'll be in touch.")
        ok, _ = lever._looks_successful(page)
        self.assertTrue(ok)


# --------------------------------------------------------------------------
# _find_submit
# --------------------------------------------------------------------------
class FindSubmitTests(unittest.TestCase):
    def test_greenhouse_finds_role_button(self):
        page = FakePage().with_role_button("submit", [FakeElement("Submit Application")])
        self.assertIsNotNone(gh._find_submit(page))

    def test_greenhouse_none_when_absent(self):
        self.assertIsNone(gh._find_submit(FakePage()))

    def test_ashby_falls_back_to_selector(self):
        page = FakePage().with_selector("button[type=submit]", [FakeElement("Go")])
        self.assertIsNotNone(ashby._find_submit(page))

    def test_ashby_does_not_match_bare_apply_cta(self):
        # "Apply" on some Ashby pages is the pre-form CTA, not the final
        # submit. Only "submit"-shaped names / selectors should match.
        page = FakePage().with_role_button("apply", [FakeElement("Apply")])
        self.assertIsNone(ashby._find_submit(page))

    def test_lever_none_when_absent(self):
        self.assertIsNone(lever._find_submit(FakePage()))


# --------------------------------------------------------------------------
# _validation_errors
# --------------------------------------------------------------------------
class ValidationErrorsTests(unittest.TestCase):
    def test_collects_error_text(self):
        page = FakePage().with_selector("[aria-invalid='true']", [FakeElement("Email is required")])
        self.assertEqual(gh._validation_errors(page), ["Email is required"])

    def test_empty_when_clean(self):
        self.assertEqual(ashby._validation_errors(FakePage()), [])


# --------------------------------------------------------------------------
# browser_resilience.wait_for_form_ready / dismiss_consent_banner
# --------------------------------------------------------------------------
class FormReadyTests(unittest.TestCase):
    def test_ready_when_field_and_submit_present(self):
        page = FakePage()
        page._by_selector[br._FILLABLE_FIELD_SELECTOR] = [FakeElement("", visible=True)]
        page._by_selector[br._SUBMITISH_SELECTOR] = [FakeElement("Submit")]
        self.assertTrue(br.wait_for_form_ready(page, timeout_s=0.5))

    def test_not_ready_when_no_fields(self):
        page = FakePage()
        page._by_selector[br._SUBMITISH_SELECTOR] = [FakeElement("Submit")]
        self.assertFalse(br.wait_for_form_ready(page, timeout_s=0.3))

    def test_not_ready_when_fields_hidden(self):
        page = FakePage()
        page._by_selector[br._FILLABLE_FIELD_SELECTOR] = [FakeElement("", visible=False)]
        page._by_selector[br._SUBMITISH_SELECTOR] = [FakeElement("Submit")]
        self.assertFalse(br.wait_for_form_ready(page, timeout_s=0.3))

    def test_dismiss_consent_clicks_visible_button(self):
        el = FakeElement("Accept all")
        page = FakePage().with_role_button("Accept all", [el])
        self.assertTrue(br.dismiss_consent_banner(page))
        self.assertTrue(getattr(el, "_clicked", False))

    def test_dismiss_consent_noop_when_absent(self):
        self.assertFalse(br.dismiss_consent_banner(FakePage()))


# --------------------------------------------------------------------------
# failure screenshots
# --------------------------------------------------------------------------
class DebugScreenshotTests(unittest.TestCase):
    def test_capture_returns_repo_relative_path(self):
        path = br.capture_debug_screenshot(FakePage(), "greenhouse_test-job")
        self.assertIsNotNone(path)
        self.assertTrue(path.startswith("data/screenshots/"))
        self.assertTrue(os.path.isfile(os.path.join(br._REPO_ROOT, path)))
        os.remove(os.path.join(br._REPO_ROOT, path))

    def test_capture_sanitizes_name(self):
        path = br.capture_debug_screenshot(FakePage(), "lever_../../etc/passwd")
        self.assertIsNotNone(path)
        self.assertNotIn("..", path)
        os.remove(os.path.join(br._REPO_ROOT, path))

    def test_capture_returns_none_when_screenshot_fails(self):
        page = FakePage()
        page._screenshot_raises = True
        self.assertIsNone(br.capture_debug_screenshot(page, "ashby_x"))

    def test_fail_helper_emits_failure_with_screenshot(self):
        import io
        import contextlib
        import json as _json

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = gh._fail(FakePage(), "boom", 6, "job-1")
        self.assertEqual(code, 6)
        payload = _json.loads(buf.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["message"], "boom")
        self.assertIn("screenshot", payload)
        os.remove(os.path.join(br._REPO_ROOT, payload["screenshot"]))


if __name__ == "__main__":
    unittest.main()
