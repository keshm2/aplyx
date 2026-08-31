#!/usr/bin/env python3
"""Regression coverage for docs/workday-personal-inbox-plan.md: the new
workday-verification-worker (Gmail verification ingestion) must NOT touch
the existing email-tracking-worker's post-application outcome tracking,
and the two workers must remain separate functions. Run with the rest of
the runtime suite:

  python3 -m unittest src.scripts.runtime.test_workday_inbox_regression
"""

from __future__ import annotations

import os
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
_OUTCOME_WORKER = os.path.join(_ROOT, "src", "supabase", "functions", "email-tracking-worker", "index.ts")
_VERIFICATION_WORKER = os.path.join(_ROOT, "src", "supabase", "functions", "workday-verification-worker", "index.ts")


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


class OutcomeWorkerUnchangedTests(unittest.TestCase):
    """The existing email-tracking-worker owns employer outcome tracking
    (applied_jobs.outcome_status). The personal-inbox work must not alter
    that file's outcome-writing behavior or let the new verification
    worker write outcomes."""

    def setUp(self):
        self.outcome_src = _read(_OUTCOME_WORKER)
        self.verification_src = _read(_VERIFICATION_WORKER)

    def test_outcome_worker_still_writes_outcome_status(self):
        """The outcome worker must still update applied_jobs.outcome_status.
        The load-bearing outcome-tracking behavior is intact."""
        self.assertIn("outcome_status", self.outcome_src)
        self.assertIn("from(\"applied_jobs\")", self.outcome_src)

    def test_verification_worker_does_not_write_outcomes(self):
        """The verification worker must never touch applied_jobs or
        write outcome_status; it resolves verification mail only, a
        different axis entirely. Cross-contamination would either hand an
        employer reply to a verification flow or record a verification
        code as an application outcome. The header comment legitimately
        mentions outcome_status to explain the separation; the guard is
        on the actual write paths (table references and update calls),
        not on comment text."""
        # No applied_jobs table reference anywhere in the worker.
        self.assertNotIn("\"applied_jobs\"", self.verification_src)
        self.assertNotIn("'applied_jobs'", self.verification_src)
        # No outcome_status write (the outcome worker's load-bearing
        # mutation). The word may appear in the explanatory header
        # comment, but never as an update field.
        self.assertNotIn("outcome_status:", self.verification_src)
        self.assertNotIn("outcome_status :", self.verification_src)

    def test_workers_are_separate_files(self):
        """The two workers must remain separate Edge Functions, not merged:
        the plan explicitly says 'Do not confuse this with the existing
        post-application outcome worker; share safe utilities only if
        appropriate.'"""
        self.assertNotEqual(_OUTCOME_WORKER, _VERIFICATION_WORKER)
        self.assertTrue(os.path.exists(_OUTCOME_WORKER))
        self.assertTrue(os.path.exists(_VERIFICATION_WORKER))

    def test_verification_worker_uses_verification_tables_not_inbound(self):
        """The verification worker must use the verification-session RPCs
        (migration 0038: service_list_active_workday_sessions /
        service_record_verification_message /
        service_update_verification_session_status), not the managed-alias
        inbound_emails table; the personal-inbox path is distinct from
        the managed-alias path."""
        self.assertIn("service_list_active_workday_sessions", self.verification_src)
        self.assertIn("service_record_verification_message", self.verification_src)
        self.assertIn("service_update_verification_session_status", self.verification_src)
        self.assertNotIn("inbound_emails", self.verification_src)
        self.assertNotIn("list_own_inbound_emails", self.verification_src)


class BridgeArgvSecrecyTests(unittest.TestCase):
    """Finding 3/11: when a session secret file exists, the raw
    --verification-link/--otp must NOT be passed in argv. The bridge
    (helpers.ts) and the Rust bridge (lib.rs) must not expose token
    contents in process argv/logs."""

    def setUp(self):
        self.helpers_src = _read(os.path.join(_ROOT, "src", "core", "src", "helpers.ts"))
        self.bridge_src = _read(os.path.join(_ROOT, "src", "core", "src", "bridge.ts"))
        self.review_src = _read(os.path.join(_ROOT, "src", "tauri", "src", "routes", "shell", "ReviewScreen.tsx"))

    def test_helpers_omits_raw_argv_when_session_secret_file_exists(self):
        """helpers.ts approveReadyToSubmit must NOT pass
        --verification-link/--otp when --session-secret-file is set."""
        self.assertIn("sessionSecretFile", self.helpers_src)
        self.assertNotIn('"--verification-link"', self.helpers_src)
        self.assertNotIn('"--otp"', self.helpers_src)

    def test_review_screen_omits_raw_argv_when_session_secret_file_exists(self):
        """ReviewScreen.tsx must not pass verificationLink/verificationOtp
        to approveSubmit when sessionSecretFile is set."""
        self.assertNotIn("verificationLink, verificationOtp", self.review_src)

    def test_review_screen_reveals_before_consume(self):
        """Finding 8: ReviewScreen must reveal the secret (not consume)
        before the runtime call, and consume only after the runtime
        reports used_verification_link/otp."""
        self.assertIn("revealVerificationSecret", self.review_src)
        self.assertIn("consumeVerificationSecret", self.review_src)
        # Consume must be called AFTER approveSubmit, gated on
        # usedVerificationLink/usedVerificationOtp.
        consume_idx = self.review_src.index("consumeVerificationSecret")
        approve_idx = self.review_src.index("approveSubmit(root, entry, {")
        self.assertGreater(consume_idx, approve_idx,
                           "consume must come after approveSubmit in the source")
        self.assertIn("result.usedVerificationLink || result.usedVerificationOtp", self.review_src)

    def test_bridge_write_session_secret_file_uses_0600(self):
        """The bridge's writeSessionSecretFile must create the file with
        mode 0600; the file holds a one-time verification credential."""
        self.assertIn("0o600", self.bridge_src)

    def test_no_heuristic_company_domain_in_review_screen(self):
        """Finding 5: expectedSenderDomainsFor must NOT generate heuristic
        company domain guesses (the old `${slug}.com` pattern)."""
        self.assertNotIn("slug", self.review_src)
        # The function should only include workday.com and the tenant.
        func_start = self.review_src.index("function expectedSenderDomainsFor")
        func_end = self.review_src.index("}", self.review_src.index('return domains;', func_start)) + 1
        func_body = self.review_src[func_start:func_end]
        self.assertNotIn(".com`", func_body.replace('"workday.com"', ''))
        self.assertNotIn("replace(/[^a-z0-9]/g", func_body)


class WorkerCorrelationTests(unittest.TestCase):
    """Finding 5/11: the worker's correlation logic must anchor sender
    domain matching to actual email domains, not substring matching."""

    def setUp(self):
        self.worker_logic = _read(os.path.join(_ROOT, "src", "supabase", "functions", "workday-verification-worker", "worker_logic.ts"))

    def test_correlate_uses_domain_extraction_not_substring(self):
        """The correlate function must extract the domain from the From
        address and compare anchored, not use substring includes() on the
        raw From header."""
        self.assertIn("extractDomain", self.worker_logic)
        self.assertIn("domainMatches", self.worker_logic)

    def test_correlate_requires_independent_signal(self):
        """The correlate function must require an independent correlation
        signal (sender/subject/tenant) in addition to recipient match."""
        self.assertIn("no independent correlation signal", self.worker_logic)

    def test_email_normalization_exports_exist(self):
        """Finding 9: the worker must export email normalization helpers
        for display names, plus addressing, and Gmail dot normalization."""
        self.assertIn("extractEmailAddress", self.worker_logic)
        self.assertIn("normalizeEmailForCompare", self.worker_logic)

    def test_worker_persists_rotated_refresh_token(self):
        """Finding 10: the worker must persist a returned refresh token
        if Google rotates one during access token refresh."""
        worker_index = _read(os.path.join(_ROOT, "src", "supabase", "functions", "workday-verification-worker", "index.ts"))
        self.assertIn("service_update_mail_connection_refresh_token", worker_index)
        self.assertIn("refresh_token", worker_index)


if __name__ == "__main__":
    unittest.main()
