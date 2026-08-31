#!/usr/bin/env python3
"""Unit tests for validate_local_config.py's placeholder rejection in
required safe_fields (fix 6). Run:
  python3 -m unittest src.scripts.validate.test_validate_local_config
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

import validate_local_config as vlc  # noqa: E402


def _base_targets():
    return {
        "role_keywords": ["intern"],
        "level_keywords": ["intern"],
        "preferred_locations": [],
        "fallback_scope": "United States",
        "boards": ["workday"],
        "safe_fields": {
            "first_name": "John",
            "last_name": "Doe",
            "email": "john@example.com",
            "phone": "555-1234",
            "graduation_date": "2027",
            "gpa": "3.8",
            "authorized_to_work": "Yes",
            "require_sponsorship": "No",
            "citizenship_status": "US",
            "currently_enrolled": "Yes",
            "linkedin_username": "johndoe",
            "github_username": "johndoe",
        },
    }


def _write_config(tmp: str, targets: dict) -> None:
    cfg_dir = os.path.join(tmp, "src", "config")
    os.makedirs(cfg_dir, exist_ok=True)
    with open(os.path.join(cfg_dir, "targets.json"), "w", encoding="utf-8") as f:
        json.dump(targets, f)


class PlaceholderSafeFieldTests(unittest.TestCase):
    """Fix 6: the validator must reject REPLACE_ME/YOUR_ placeholders in
    required safe_fields, matching the runtime's _read_safe_fields which
    skips placeholder values."""

    def test_replace_me_in_required_field_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            targets = _base_targets()
            targets["safe_fields"]["first_name"] = "REPLACE_ME"
            _write_config(tmp, targets)
            with self.assertRaises(SystemExit) as ctx:
                vlc.main([tmp])
            self.assertEqual(ctx.exception.code, 1)

    def test_your_prefix_in_required_field_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            targets = _base_targets()
            targets["safe_fields"]["email"] = "YOUR_EMAIL_HERE"
            _write_config(tmp, targets)
            with self.assertRaises(SystemExit) as ctx:
                vlc.main([tmp])
            self.assertEqual(ctx.exception.code, 1)

    def test_real_values_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_config(tmp, _base_targets())
            # Should not raise: real values are valid.
            vlc.main([tmp])

    def test_placeholder_pair_does_not_count_as_configured(self):
        with tempfile.TemporaryDirectory() as tmp:
            targets = _base_targets()
            targets["safe_fields"]["linkedin_username"] = "REPLACE_ME"
            targets["safe_fields"]["linkedin_url"] = " "
            _write_config(tmp, targets)
            with self.assertRaises(SystemExit) as ctx:
                vlc.main([tmp])
            self.assertEqual(ctx.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
