#!/usr/bin/env python3
"""Unit tests for resume_graduation.derive_graduation_date.

Run: python3 -m unittest src.scripts.runtime.test_resume_graduation
or:  python3 src/scripts/state/test_resume_graduation.py
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import datetime as dt  # noqa: E402

from resume_graduation import derive_graduation_date, derive_recruiting_stage  # noqa: E402

_TODAY = dt.date(2026, 9, 1)


def edu(dates="", details=None, degree="B.S. CS", school="State U"):
    return {"dates": dates, "degree": degree, "school": school, "details": details or []}


class DeriveTests(unittest.TestCase):
    def test_range_with_end_month_year(self):
        r = derive_graduation_date([edu("Sep 2023 – Jun 2027")])
        self.assertEqual(r["graduation_date"], "June 2027")
        self.assertEqual(r["confidence"], "high")

    def test_range_ascii_hyphen(self):
        r = derive_graduation_date([edu("Aug 2024 - May 2028")])
        self.assertEqual(r["graduation_date"], "May 2028")
        self.assertEqual(r["confidence"], "high")

    def test_expected_month_year_single_value(self):
        r = derive_graduation_date([edu("Expected December 2027")])
        self.assertEqual(r["graduation_date"], "December 2027")
        self.assertEqual(r["confidence"], "high")

    def test_class_of_year_only_is_high_via_context(self):
        r = derive_graduation_date([edu("Class of 2027")])
        self.assertEqual(r["graduation_date"], "2027")
        self.assertEqual(r["confidence"], "high")

    def test_sole_entry_bare_year_range_is_high(self):
        # one degree, a clear span ending 2027: best signal we have
        r = derive_graduation_date([edu("2023 - 2027")])
        self.assertEqual(r["graduation_date"], "2027")
        self.assertEqual(r["confidence"], "high")

    def test_sole_entry_bare_year_is_high(self):
        r = derive_graduation_date([edu("2027")])
        self.assertEqual(r["graduation_date"], "2027")
        self.assertEqual(r["confidence"], "high")

    def test_bare_year_no_month_no_context_multi_entry_is_low(self):
        r = derive_graduation_date([
            edu("2019 – 2023", degree="B.A."),
            edu("2025", degree="M.A."),
        ])
        self.assertEqual(r["graduation_date"], "2025")
        self.assertEqual(r["confidence"], "low")

    def test_present_end_with_no_future_year_is_none(self):
        r = derive_graduation_date([edu("Sep 2023 – Present")])
        self.assertEqual(r["confidence"], "none")
        self.assertEqual(r["graduation_date"], "")

    def test_present_but_expected_year_in_text_is_high(self):
        r = derive_graduation_date([edu("Sep 2024 – Present (Expected May 2028)")])
        self.assertEqual(r["graduation_date"], "May 2028")
        self.assertEqual(r["confidence"], "high")

    def test_graduation_date_on_a_detail_line(self):
        r = derive_graduation_date([edu("Seattle, WA", details=["Expected graduation: June 2026", "GPA 3.9"])])
        self.assertEqual(r["graduation_date"], "June 2026")
        self.assertEqual(r["confidence"], "high")

    def test_latest_ending_degree_wins(self):
        r = derive_graduation_date([
            edu("Sep 2019 – Jun 2023", degree="B.S."),
            edu("Sep 2024 – Jun 2026", degree="M.S."),
        ])
        self.assertEqual(r["graduation_date"], "June 2026")
        self.assertIn("M.S.", r["source"])

    def test_no_education_section(self):
        r = derive_graduation_date([])
        self.assertEqual(r["confidence"], "none")

    def test_unparseable_dates(self):
        r = derive_graduation_date([edu("sometime soon")])
        self.assertEqual(r["confidence"], "none")

    def test_non_dict_entries_are_skipped(self):
        r = derive_graduation_date(["garbage", edu("Sep 2023 – Jun 2027")])
        self.assertEqual(r["graduation_date"], "June 2027")


class RecruitingStageTests(unittest.TestCase):
    def test_graduating_soon_is_new_grad(self):
        r = derive_recruiting_stage("June 2027", _TODAY)  # ~9 months out
        self.assertEqual(r["stage"], "new_grad")
        self.assertIn("new_grad", r["level_ids"])
        self.assertIn("entry_level", r["level_ids"])
        self.assertNotIn("intern", r["level_ids"])

    def test_one_more_summer_is_internship(self):
        r = derive_recruiting_stage("December 2027", _TODAY)  # ~15 months out
        self.assertEqual(r["stage"], "internship")
        self.assertEqual(r["level_ids"], ["intern"])

    def test_far_out_is_internship(self):
        r = derive_recruiting_stage("May 2029", _TODAY)
        self.assertEqual(r["stage"], "internship")

    def test_past_graduation_is_new_grad(self):
        r = derive_recruiting_stage("May 2026", _TODAY)  # already past
        self.assertEqual(r["stage"], "new_grad")

    def test_unknown_date_defaults_to_intern_and_new_grad(self):
        r = derive_recruiting_stage("", _TODAY)
        self.assertEqual(r["stage"], "unknown")
        self.assertEqual(set(r["level_ids"]), {"intern", "new_grad"})


if __name__ == "__main__":
    unittest.main()
