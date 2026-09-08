#!/usr/bin/env python3
"""Unit tests for replay_fill.py's fill-target guard (_value_shape,
_target_mismatch, fill_field), added 2026-09-08 for the real Workday bug:
a label-substring collision ("Address" fuzzy-matching "Email Address")
let a street-address value land in an email input on at least one tenant.
No browser, no network; a FakeLocator stands in for Playwright's Locator.

Run: python3 src/scripts/runtime/test_replay_fill.py
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import replay_fill as rf  # noqa: E402


class FakeLocator:
    """Minimal stand-in for a Playwright Locator: only what fill_field and
    _target_mismatch actually call (get_attribute, evaluate, fill)."""

    def __init__(self, tag="input", input_type="", accessible_name="", raise_on_fill=False):
        self._tag = tag
        self._attrs = {"type": input_type} if input_type else {}
        self._accname = accessible_name
        self._raise_on_fill = raise_on_fill
        self.filled_with = None

    def get_attribute(self, attr):
        return self._attrs.get(attr)

    def evaluate(self, expr):
        if "tagName" in expr:
            return self._tag
        if "aria-label" in expr:  # the accessible-name probe in _target_mismatch
            return self._accname
        return ""

    def fill(self, value):
        if self._raise_on_fill:
            raise RuntimeError("simulated fill failure")
        self.filled_with = value


class ValueShapeTests(unittest.TestCase):
    def test_email_shape(self):
        self.assertTrue(rf._value_shape("a@b.com")["email"])
        self.assertFalse(rf._value_shape("123 Main St")["email"])

    def test_url_shape(self):
        self.assertTrue(rf._value_shape("https://linkedin.com/in/x")["url"])
        self.assertFalse(rf._value_shape("linkedin.com/in/x")["url"])


class TargetMismatchTests(unittest.TestCase):
    """The regression this exists for: an 'Address' label match resolving
    to Workday's email input (pre-filled during account creation, never
    routed through this pass's own 'already filled' guard), with a real
    street-address value about to be written into it."""

    def test_street_value_into_email_input_is_rejected(self):
        loc = FakeLocator(input_type="email")
        note = rf._target_mismatch(loc, "Address", "123 Main St, Springfield, IL")
        self.assertIsNotNone(note)

    def test_real_email_into_email_input_is_accepted(self):
        loc = FakeLocator(input_type="email")
        note = rf._target_mismatch(loc, "Email Address", "person@example.com")
        self.assertIsNone(note)

    def test_email_accessible_name_without_type_attr_is_also_caught(self):
        # Some Workday inputs carry no type="email" but do expose an
        # accessible name containing "Email" (aria-label/label/placeholder).
        loc = FakeLocator(input_type="text", accessible_name="Email Address")
        note = rf._target_mismatch(loc, "Address", "123 Main St")
        self.assertIsNotNone(note)

    def test_unrelated_label_landing_on_phone_input_is_rejected(self):
        # The phone-field analogue of the email collision: the label
        # asked for ("Location") has nothing to do with a phone number,
        # and the value about to be written isn't one either.
        loc = FakeLocator(input_type="tel")
        note = rf._target_mismatch(loc, "Location", "Springfield")
        self.assertIsNotNone(note)

    def test_phone_field_accepts_real_phone(self):
        loc = FakeLocator(input_type="tel")
        note = rf._target_mismatch(loc, "Mobile Phone", "555-0142")
        self.assertIsNone(note)

    def test_non_email_field_is_unaffected(self):
        loc = FakeLocator(input_type="text")
        note = rf._target_mismatch(loc, "Street Address", "123 Main St")
        self.assertIsNone(note)

    def test_city_value_into_ethnicity_field_is_rejected(self):
        # "City" is a literal substring of "Ethnicity" — a second real
        # collision of the same class as Address/Email, caught here by
        # accessible-name category instead of value shape (both are plain
        # text/select controls with no distinguishing input type).
        loc = FakeLocator(input_type="text", accessible_name="Ethnicity")
        note = rf._target_mismatch(loc, "City", "San Francisco")
        self.assertIsNotNone(note)

    def test_ethnicity_value_into_ethnicity_field_is_accepted(self):
        loc = FakeLocator(input_type="text", accessible_name="Ethnicity")
        note = rf._target_mismatch(loc, "Ethnicity", "Asian")
        self.assertIsNone(note)


class FillFieldGuardTests(unittest.TestCase):
    """fill_field itself, with locate_field monkeypatched so this stays a
    pure unit test of the guard wiring, not of label/accessible-name
    resolution (already covered by TargetMismatchTests and by
    approve_submit_workday's own label list)."""

    def setUp(self):
        self._orig_locate = rf.locate_field

    def tearDown(self):
        rf.locate_field = self._orig_locate

    def test_collision_is_unmatched_not_filled(self):
        loc = FakeLocator(input_type="email")
        rf.locate_field = lambda page, field_name: loc
        status, note = rf.fill_field(None, "Address", "123 Main St, Springfield, IL")
        self.assertEqual(status, "unmatched")
        self.assertIsNone(loc.filled_with, "the street value must never reach .fill() on an email input")

    def test_correct_target_still_fills(self):
        loc = FakeLocator(input_type="text")
        rf.locate_field = lambda page, field_name: loc
        status, note = rf.fill_field(None, "Street Address", "123 Main St")
        self.assertEqual(status, "filled")
        self.assertEqual(loc.filled_with, "123 Main St")

    def test_no_locator_found_is_unmatched(self):
        rf.locate_field = lambda page, field_name: None
        status, note = rf.fill_field(None, "Some Label", "value")
        self.assertEqual(status, "unmatched")

    def test_empty_value_is_skipped_before_any_lookup(self):
        called = {"n": 0}

        def spy(page, field_name):
            called["n"] += 1
            return FakeLocator()

        rf.locate_field = spy
        status, note = rf.fill_field(None, "Address", "")
        self.assertEqual(status, "skipped")
        self.assertEqual(called["n"], 0)


if __name__ == "__main__":
    unittest.main()
