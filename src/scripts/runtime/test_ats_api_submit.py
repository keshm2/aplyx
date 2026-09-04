#!/usr/bin/env python3
"""Deterministic unit tests for ats_api_submit.py.

Every network call is monkeypatched — no real HTTP, no application is ever
submitted. Covers URL parsing, fill-record normalization, the Lever POST
body, the Greenhouse question mapping, and the fall-back contract the
approve_submit runtimes rely on.

Run: python3 -m unittest src.scripts.runtime.test_ats_api_submit
or:  python3 src/scripts/runtime/test_ats_api_submit.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ats_api_submit as api  # noqa: E402


def _fields(*entries: dict) -> list[dict]:
    return list(entries)


def sf(key: str, value: str) -> dict:
    return {"field_name": key, "filled_value": value, "source": f"safe_fields:{key}", "verified": True}


class ParseUrlTests(unittest.TestCase):
    def test_lever_apply_url(self):
        self.assertEqual(
            api.parse_lever_posting("https://jobs.lever.co/acme/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d/apply"),
            ("acme", "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"),
        )

    def test_lever_api_url(self):
        self.assertEqual(
            api.parse_lever_posting("https://api.lever.co/v0/postings/acme/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"),
            ("acme", "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"),
        )

    def test_lever_rejects_non_uuid(self):
        self.assertIsNone(api.parse_lever_posting("https://jobs.lever.co/acme/engineering"))

    def test_greenhouse_embed_url(self):
        self.assertEqual(
            api.parse_greenhouse_posting("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=4567890"),
            ("acme", "4567890"),
        )

    def test_greenhouse_boards_url(self):
        self.assertEqual(
            api.parse_greenhouse_posting("https://boards.greenhouse.io/acme/jobs/4567890"),
            ("acme", "4567890"),
        )

    def test_greenhouse_api_url(self):
        self.assertEqual(
            api.parse_greenhouse_posting("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4567890"),
            ("acme", "4567890"),
        )


class NormalizeTests(unittest.TestCase):
    def test_maps_safe_fields_and_composes_name(self):
        fm = api.normalize_fields(
            _fields(sf("first_name", "Ada"), sf("last_name", "Lovelace"), sf("email", "ada@example.com")),
            None,
        )
        self.assertEqual(fm.full_name, "Ada Lovelace")
        self.assertEqual(fm.values["email"], "ada@example.com")

    def test_linkedin_username_becomes_url(self):
        fm = api.normalize_fields(_fields(sf("linkedin_username", "ada-l")), None)
        self.assertEqual(fm.link("linkedin"), "https://www.linkedin.com/in/ada-l")

    def test_linkedin_full_url_passes_through(self):
        fm = api.normalize_fields(_fields(sf("linkedin_url", "https://linkedin.com/in/ada")), None)
        self.assertEqual(fm.link("linkedin"), "https://linkedin.com/in/ada")

    def test_conservative_default_is_custom(self):
        fm = api.normalize_fields(
            _fields({"field_name": "Are you 18 or older?", "filled_value": "Yes",
                     "source": "conservative_default", "verified": True}),
            None,
        )
        self.assertEqual(fm.custom, [("Are you 18 or older?", "Yes")])

    def test_resume_upload_filename_not_treated_as_field(self):
        fm = api.normalize_fields(
            _fields({"field_name": "Resume", "filled_value": "resume.pdf",
                     "source": "resume_upload", "verified": True}),
            "/tmp/resume.pdf",
        )
        self.assertEqual(fm.resume_path, "/tmp/resume.pdf")
        self.assertEqual(fm.values, {})


class LeverSubmitTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self._orig = api._http
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.write(b"%PDF-1.4 fake")
        tmp.close()
        self.resume = tmp.name
        self.addCleanup(lambda: os.unlink(self.resume))
        self.addCleanup(lambda: setattr(api, "_http", self._orig))

    def _patch_http(self, status, text):
        def fake(method, url, **kw):
            self.calls.append({"method": method, "url": url, **kw})
            return status, text
        api._http = fake

    def _fm(self):
        return api.normalize_fields(
            _fields(sf("first_name", "Ada"), sf("last_name", "Lovelace"),
                    sf("email", "ada@example.com"), sf("phone", "555-0100"),
                    sf("linkedin_username", "ada-l")),
            self.resume,
        )

    def test_clean_submit(self):
        self._patch_http(200, json.dumps({"ok": True, "applicationId": "app_123"}))
        out = api.submit_lever("acme", "u-u-i-d-x", self._fm())
        self.assertEqual(out["status"], "submitted")
        self.assertIn("app_123", out["message"])
        body = self.calls[0]["body"].decode("utf-8", "replace")
        self.assertIn('name="name"', body)
        self.assertIn("Ada Lovelace", body)
        self.assertIn('name="email"', body)
        self.assertIn('name="urls[LinkedIn]"', body)
        self.assertIn('name="resume"; filename=', body)
        self.assertIn('name="source"', body)  # honest attribution

    def test_custom_questions_fall_back(self):
        self._patch_http(200, json.dumps({"ok": True}))
        fm = self._fm()
        fm.custom.append(("Why do you want this role?", "Because reasons"))
        out = api.submit_lever("acme", "u-u-i-d-x", fm)
        self.assertEqual(out["status"], "fallback")
        self.assertEqual(self.calls, [])  # never even sent

    def test_ambiguous_200_falls_back(self):
        self._patch_http(200, "OK")  # no JSON application id
        out = api.submit_lever("acme", "u-u-i-d-x", self._fm())
        self.assertEqual(out["status"], "fallback")

    def test_captcha_response_falls_back(self):
        self._patch_http(200, "please complete the reCAPTCHA challenge")
        out = api.submit_lever("acme", "u-u-i-d-x", self._fm())
        self.assertEqual(out["status"], "fallback")
        self.assertIn("challenge", out["reason"].lower())

    def test_transport_error_falls_back(self):
        self._patch_http(None, "Connection refused")
        out = api.submit_lever("acme", "u-u-i-d-x", self._fm())
        self.assertEqual(out["status"], "fallback")

    def test_422_rejection_falls_back(self):
        self._patch_http(422, json.dumps({"error": "email required"}))
        out = api.submit_lever("acme", "u-u-i-d-x", self._fm())
        self.assertEqual(out["status"], "fallback")


class GreenhouseSubmitTests(unittest.TestCase):
    def setUp(self):
        self._orig = api._http
        self._orig_key = api._greenhouse_board_key
        self.addCleanup(lambda: setattr(api, "_http", self._orig))
        self.addCleanup(lambda: setattr(api, "_greenhouse_board_key", self._orig_key))

    def test_no_key_falls_back_without_network(self):
        api._greenhouse_board_key = lambda token: None
        calls = []
        api._http = lambda *a, **k: (calls.append(a) or (200, "{}"))
        fm = api.normalize_fields(_fields(sf("email", "ada@example.com")), None)
        out = api.submit_greenhouse("acme", "123", fm)
        self.assertEqual(out["status"], "fallback")
        self.assertIn("api key", out["reason"].lower())
        self.assertEqual(calls, [])

    def test_with_key_maps_questions_and_submits(self):
        api._greenhouse_board_key = lambda token: "test-key"
        questions = {
            "questions": [
                {"label": "First Name", "required": True, "fields": [{"name": "first_name", "type": "input_text"}]},
                {"label": "Last Name", "required": True, "fields": [{"name": "last_name", "type": "input_text"}]},
                {"label": "Email", "required": True, "fields": [{"name": "email", "type": "input_text"}]},
                {"label": "Resume", "required": True, "fields": [{"name": "resume", "type": "attachment"}]},
            ]
        }

        seq = [(200, json.dumps(questions)), (200, json.dumps({"success": True, "id": 99}))]
        posted = {}

        def fake(method, url, **kw):
            if method == "POST":
                posted["body"] = kw.get("body")
                posted["headers"] = kw.get("headers")
            return seq.pop(0)

        api._http = fake
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.write(b"%PDF fake")
        tmp.close()
        self.addCleanup(lambda: os.unlink(tmp.name))
        fm = api.normalize_fields(
            _fields(sf("first_name", "Ada"), sf("last_name", "Lovelace"), sf("email", "ada@example.com")),
            tmp.name,
        )
        out = api.submit_greenhouse("acme", "123", fm)
        self.assertEqual(out["status"], "submitted")
        self.assertIn("Authorization", posted["headers"])
        body = posted["body"].decode("utf-8", "replace")
        self.assertIn("Ada", body)
        self.assertIn('filename=', body)

    def test_unmapped_required_field_falls_back(self):
        api._greenhouse_board_key = lambda token: "test-key"
        questions = {
            "questions": [
                {"label": "Email", "required": True, "fields": [{"name": "email", "type": "input_text"}]},
                {"label": "Portfolio URL", "required": True, "fields": [{"name": "q_9", "type": "input_text"}]},
            ]
        }
        api._http = lambda method, url, **kw: (200, json.dumps(questions))
        fm = api.normalize_fields(_fields(sf("email", "ada@example.com")), None)
        out = api.submit_greenhouse("acme", "123", fm)
        self.assertEqual(out["status"], "fallback")
        self.assertIn("Portfolio URL", out["reason"])


class DispatcherTests(unittest.TestCase):
    def test_disabled_returns_skipped(self):
        out = api.try_api_submit("lever", "https://jobs.lever.co/x/a-b-c-d", [], None, enabled=False)
        self.assertEqual(out["status"], "skipped")

    def test_ashby_always_falls_back(self):
        out = api.try_api_submit("ashbyhq", "https://jobs.ashbyhq.com/acme/abc", [], None, enabled=True)
        self.assertEqual(out["status"], "fallback")

    def test_unparseable_url_falls_back(self):
        out = api.try_api_submit("lever", "https://example.com/nope", [], None, enabled=True)
        self.assertEqual(out["status"], "fallback")

    def test_exception_is_caught_as_fallback(self):
        orig = api.submit_lever
        api.submit_lever = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            out = api.try_api_submit(
                "lever", "https://jobs.lever.co/x/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", [], None, enabled=True
            )
        finally:
            api.submit_lever = orig
        self.assertEqual(out["status"], "fallback")
        self.assertIn("boom", out["reason"])


if __name__ == "__main__":
    unittest.main()
