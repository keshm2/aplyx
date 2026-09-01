#!/usr/bin/env python3
"""Deterministic regression tests for evaluate_job_fit.py's hard-reject
gates. No network, no LLM, same spirit as
src/scripts/runtime/test_approve_submit_workday.py (the only other test
file in this repo): direct import, unittest, run by hand.

Seeded from a real finding, not hypotheticals: the FOREIGN_LOCATION_RE
regex originally only listed countries, so a JD naming just a city
("Bengaluru, Karnataka") slipped through undetected until it actually
happened on live traffic (see the comment at FOREIGN_LOCATION_RE's
definition). This suite exists so the *next* gap in this style is
caught here, not on a real posting.

Run: python3 -m unittest src.scripts.jobs.test_evaluate_job_fit
or:  python3 src/scripts/jobs/test_evaluate_job_fit.py
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import evaluate_job_fit as fit  # noqa: E402

BASE_TARGETS = {
    "role_keywords": ["software engineer", "swe"],
    "level_keywords": ["intern", "internship", "new grad"],
    "graduation_date": "May 2027",
}


def clean_job(**overrides) -> dict:
    job = {
        "title": "Software Engineer Intern",
        "company": "Acme Corp",
        "location": "Seattle, WA",
        "jd_text": (
            "Acme is hiring a Software Engineer Intern for Summer 2027. "
            "You will build backend services in Python. Currently enrolled "
            "in a CS degree required."
        ),
        "role_type": "internship",
    }
    job.update(overrides)
    return job


class ForeignLocationRegressionTests(unittest.TestCase):
    """Locks in the already-fixed Bengaluru bug, then extends coverage to
    the gaps found in the same audit (more Indian/Chinese/Gulf cities,
    several previously-missing countries)."""

    def test_city_only_no_country_named_still_rejects(self):
        # The exact real-world shape that slipped through originally.
        job = clean_job(location="Bengaluru, Karnataka")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_newly_added_indian_city(self):
        job = clean_job(location="Ahmedabad, Gujarat")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_newly_added_gulf_city(self):
        job = clean_job(location="Doha, Qatar")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_newly_added_country_iceland(self):
        job = clean_job(location="Remote, Iceland")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_newly_added_country_costa_rica(self):
        job = clean_job(location="San Jose, Costa Rica")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_ordinary_us_city_is_not_falsely_rejected(self):
        # Guard against the broadened regex over-matching a real US
        # location that happens to share a substring with a new entry.
        job = clean_job(location="Boston, MA")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertNotEqual(result["fit_status"], "skipped_unfit")


class SponsorshipGateTests(unittest.TestCase):
    """New gate added alongside this suite: a JD that won't sponsor a
    visa, or that requires citizenship/permanent residency, is only a
    hard reject for a candidate who actually needs sponsorship, never
    unconditionally, since most configured candidates don't."""

    def test_no_sponsorship_language_rejects_when_candidate_needs_it(self):
        targets = {**BASE_TARGETS, "safe_fields": {"require_sponsorship": "yes"}}
        job = clean_job(jd_text=clean_job()["jd_text"] + " We are unable to sponsor work visas for this role.")
        result = fit.evaluate_fit(job, targets)
        self.assertEqual(result["fit_status"], "skipped_unfit")
        self.assertIn("sponsorship", result["reasoning"].lower())

    def test_us_citizens_only_language_rejects_when_candidate_needs_sponsorship(self):
        targets = {**BASE_TARGETS, "safe_fields": {"require_sponsorship": "yes"}}
        job = clean_job(jd_text=clean_job()["jd_text"] + " Must be a U.S. citizen due to government contract requirements.")
        result = fit.evaluate_fit(job, targets)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_no_sponsorship_language_does_not_reject_when_candidate_does_not_need_it(self):
        targets = {**BASE_TARGETS, "safe_fields": {"require_sponsorship": "no"}}
        job = clean_job(jd_text=clean_job()["jd_text"] + " We are unable to sponsor work visas for this role.")
        result = fit.evaluate_fit(job, targets)
        self.assertNotEqual(result["fit_status"], "skipped_unfit")

    def test_no_sponsorship_field_at_all_defaults_to_not_needed(self):
        # No require_sponsorship key set anywhere: must not silently
        # start rejecting every "no sponsorship" posting for a candidate
        # who never said they needed one.
        job = clean_job(jd_text=clean_job()["jd_text"] + " Sponsorship is not available for this position.")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertNotEqual(result["fit_status"], "skipped_unfit")

    def test_needs_sponsorship_but_jd_silent_on_it_is_unaffected(self):
        targets = {**BASE_TARGETS, "safe_fields": {"require_sponsorship": "yes"}}
        job = clean_job()  # no visa/sponsorship language at all
        result = fit.evaluate_fit(job, targets)
        self.assertNotEqual(result["fit_status"], "skipped_unfit")


class OtherHardRejectSanityTests(unittest.TestCase):
    """One case per existing hard-reject category, to catch a future
    edit to evaluate_fit's branch ordering breaking one of them."""

    def test_years_of_experience_without_welcoming_language_rejects(self):
        job = clean_job(
            title="Software Engineer",
            role_type="",
            jd_text="Acme seeks a Software Engineer with 5+ years of professional experience.",
        )
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_advanced_degree_required_rejects(self):
        job = clean_job(jd_text=clean_job()["jd_text"] + " A Master's degree is required for this role.")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_active_clearance_required_rejects(self):
        job = clean_job(jd_text=clean_job()["jd_text"] + " Candidate must hold an active security clearance.")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_clearance_eligible_to_obtain_does_not_reject(self):
        job = clean_job(jd_text=clean_job()["jd_text"] + " Candidate must be eligible to obtain a security clearance.")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertNotEqual(result["fit_status"], "skipped_unfit")

    def test_opt_cpt_only_requirement_rejects(self):
        job = clean_job(jd_text=clean_job()["jd_text"] + " Applicants must be on OPT status.")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_no_role_keyword_match_rejects(self):
        job = clean_job(title="Product Manager Intern", jd_text="We are hiring a Product Manager Intern.")
        result = fit.evaluate_fit(job, BASE_TARGETS)
        self.assertEqual(result["fit_status"], "skipped_unfit")

    def test_clean_internship_posting_is_not_rejected(self):
        result = fit.evaluate_fit(clean_job(), BASE_TARGETS)
        self.assertNotEqual(result["fit_status"], "skipped_unfit")


class ResumeGraduationSourceOfTruthTests(unittest.TestCase):
    """load_targets() overrides safe_fields.graduation_date with a
    confident value read from data/resumes/resume.json, so updating the
    resume PDF (not the config) is what shifts which class years pass."""

    def _targets_dir(self, grad_dates: str | None):
        import json
        import tempfile

        d = tempfile.mkdtemp()
        cfg_dir = os.path.join(d, "src", "config")
        res_dir = os.path.join(d, "data", "resumes")
        os.makedirs(cfg_dir)
        os.makedirs(res_dir)
        targets_path = os.path.join(cfg_dir, "targets.json")
        with open(targets_path, "w") as fh:
            json.dump({
                "role_keywords": ["software engineer"],
                "level_keywords": ["intern"],
                "preferred_locations": ["Seattle"],
                "fallback_scope": "none",
                "safe_fields": {"graduation_date": "May 2026"},
            }, fh)
        if grad_dates is not None:
            with open(os.path.join(res_dir, "resume.json"), "w") as fh:
                json.dump({"education": [{"degree": "B.S. CS", "school": "U", "dates": grad_dates, "details": []}]}, fh)
        return targets_path

    def test_confident_resume_date_overrides_config(self):
        job = clean_job(jd_text=(
            "Software Engineer Intern. We only consider candidates graduating in "
            "the class of 2028. Currently enrolled in a CS degree required. "
            "Build backend services in Python."
        ))
        # Config alone (May 2026) hard-rejects on the class-year mismatch.
        cfg_only = {**BASE_TARGETS, "safe_fields": {"graduation_date": "May 2026"}}
        self.assertEqual(fit.evaluate_fit(job, cfg_only)["fit_status"], "skipped_unfit")
        # A confident resume date (December 2028) is what load_targets uses instead.
        targets_path = self._targets_dir("Sep 2024 - December 2028")
        targets = fit.load_targets(targets_path)
        self.assertEqual(targets["safe_fields"]["graduation_date"], "December 2028")
        self.assertNotEqual(fit.evaluate_fit(job, targets)["fit_status"], "skipped_unfit")

    def test_low_confidence_resume_date_leaves_config_alone(self):
        targets_path = self._targets_dir("2027")  # sole entry -> actually high; use a genuinely ambiguous one
        # rewrite resume with two entries, latest a bare year (low confidence)
        import json
        res = os.path.join(os.path.dirname(targets_path), "..", "..", "data", "resumes", "resume.json")
        with open(res, "w") as fh:
            json.dump({"education": [
                {"degree": "B.A.", "school": "U", "dates": "2019 - 2023", "details": []},
                {"degree": "M.A.", "school": "U", "dates": "2025", "details": []},
            ]}, fh)
        targets = fit.load_targets(targets_path)
        self.assertEqual(targets["safe_fields"]["graduation_date"], "May 2026")

    def test_no_resume_file_leaves_config_alone(self):
        targets_path = self._targets_dir(None)
        targets = fit.load_targets(targets_path)
        self.assertEqual(targets["safe_fields"]["graduation_date"], "May 2026")


if __name__ == "__main__":
    unittest.main()
