#!/usr/bin/env python3
"""run_conformance.py — cross-harness conformance suite (Phase 16).

Two legs:

1. Deterministic leg (default, no LLM, no network): pushes a golden
   job batch through canonicalize -> fit gate -> state writes against
   TEMP files only (never data/ or src/config/), and asserts byte-stable
   results. This is the shared core every harness drives; if it holds,
   harness parity reduces to "can the harness run the helpers".

2. Harness leg (--harness NAME | --harness all): invokes the named
   coding-agent CLI headlessly with a minimal task — run one
   canonicalize via shell and print its output — and asserts the
   golden job_key appears in the transcript. Proves the harness can
   read project files and execute the deterministic helpers. Costs one
   small LLM call per harness; a missing CLI is reported as SKIP, not
   a failure, so results stay honest on machines without all four.

Usage:
  python3 src/scripts/validate/run_conformance.py                # deterministic leg
  python3 src/scripts/validate/run_conformance.py --harness all  # + every installed CLI
  python3 src/scripts/validate/run_conformance.py --harness codex

Output: one machine-parseable line per check
  conformance: <check> PASS|FAIL|SKIP[ — detail]
and a final summary line; exit 0 iff no FAIL.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
HARNESSES = ("opencode", "claude", "codex", "copilot")
HARNESS_TIMEOUT_S = 300

# Golden targets config — self-contained so the suite never reads the
# user's live src/config/targets.json.
GOLDEN_TARGETS = {
    "role_keywords": ["software engineer", "swe"],
    "level_keywords": ["intern", "internship", "new grad"],
    "season_keywords": ["summer 2027"],
    "preferred_locations": ["New York", "San Francisco"],
    "fallback_scope": "United States",
    "graduation_date": "May 2027",
}

# Golden batch: one API-board candidate, one hard-reject (required 5+
# YOE), one Workday candidate. Expected values were produced by the
# helpers themselves and are pinned here; a change in canonicalize or
# the fit gate that shifts them is a conformance break until the
# goldens are deliberately re-pinned (bump decision_version first).
GOLDEN_JOBS = [
    {
        "name": "ashby-candidate",
        "raw": {
            "source": "ashbyhq", "company": "GoldenCo",
            "title": "Software Engineer Intern", "location": "New York, NY",
            "url": "https://jobs.ashbyhq.com/goldenco/1111-2222",
            "apply_url": "https://jobs.ashbyhq.com/goldenco/1111-2222/application",
            "jd_text": "GoldenCo is hiring a Software Engineer Intern in New York for Summer 2027. You will build backend services in Python. Requirements: currently enrolled in a CS degree, strong fundamentals. Nice to have: 2+ years of hobby programming.",
        },
        "expect": {
            "job_key": "jk:5eb252b6e1228a6819fcbdbb09fd44a26f78f591a0f029cf26f982034cbb2003",
            "job_id": "ashbyhq-1111-2222", "ats_system": "ashby",
            "fit_status": "needs_review", "fit_score": 78,
            "decision_version": "phase4-v4",
        },
    },
    {
        "name": "lever-hard-reject",
        "raw": {
            "source": "lever", "company": "SeniorSoft",
            "title": "Software Engineer", "location": "Austin, TX",
            "url": "https://jobs.lever.co/seniorsoft/aaaa-bbbb",
            "jd_text": "SeniorSoft seeks a Software Engineer. Requirements: 5+ years of professional software engineering experience, expert-level distributed systems.",
        },
        "expect": {
            "job_key": "jk:a097c58fff16ef1bb0ada59d7663cb3c341e724d9e605832f8687e0eeac9c5c3",
            "job_id": "jk:a097c58fff16ef1bb0ada59d7663cb3c341e724d9e605832f8687e0eeac9c5c3",
            "ats_system": "lever",
            "fit_status": "skipped_unfit", "fit_score": 10,
            "decision_version": "phase4-v4",
        },
    },
    {
        "name": "workday-candidate",
        "raw": {
            "source": "workday", "company": "MegaCorp",
            "title": "Software Engineer Internship - Summer 2027",
            "location": "Remote - United States",
            "url": "https://megacorp.wd5.myworkdayjobs.com/en-US/External/job/SWE-Intern_JR9999",
            "external_job_id": "JR9999",
            "jd_text": "MegaCorp Software Engineer Internship, Summer 2027, remote in the United States. Work on infrastructure tooling. Must be pursuing a Bachelors degree in Computer Science.",
        },
        "expect": {
            "job_key": "jk:4a56bdab19e66a737a0f7521c76092ac0c7854ce8cfb8b285e5c7cbacd8e4411",
            "job_id": "workday-JR9999", "ats_system": "workday",
            "fit_status": "needs_review", "fit_score": 82,
            "decision_version": "phase4-v4",
        },
    },
]

PASS = 0
FAIL = 0
SKIP = 0


def report(check: str, status: str, detail: str = "") -> None:
    global PASS, FAIL, SKIP
    if status == "PASS":
        PASS += 1
    elif status == "FAIL":
        FAIL += 1
    else:
        SKIP += 1
    tail = f" — {detail}" if detail else ""
    print(f"conformance: {check} {status}{tail}")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, **kw)


def helper(name: str) -> str:
    return os.path.join(ROOT, "src", "scripts", name)


def deterministic_leg() -> None:
    tmp = tempfile.mkdtemp(prefix="aplyx-conformance-")
    targets = os.path.join(tmp, "targets.json")
    registry = os.path.join(tmp, "job_registry.json")
    events = os.path.join(tmp, "job_events.jsonl")
    applied = os.path.join(tmp, "applied_jobs.json")
    with open(targets, "w", encoding="utf-8") as f:
        json.dump(GOLDEN_TARGETS, f)
    with open(applied, "w", encoding="utf-8") as f:
        f.write("[]\n")

    canonical: dict[str, dict] = {}
    for job in GOLDEN_JOBS:
        name, expect = job["name"], job["expect"]
        p = run([sys.executable, helper("state/job_state.py"), "canonicalize", json.dumps(job["raw"])])
        if p.returncode != 0:
            report(f"canonicalize:{name}", "FAIL", p.stderr.strip()[-120:])
            continue
        rec = json.loads(p.stdout)
        canonical[name] = rec
        got = {k: rec.get(k) for k in ("job_key", "job_id", "ats_system")}
        want = {k: expect[k] for k in ("job_key", "job_id", "ats_system")}
        report(f"canonicalize:{name}", "PASS" if got == want else "FAIL",
               "" if got == want else f"got {got}")

        p = run([sys.executable, helper("jobs/evaluate_job_fit.py"), json.dumps(rec), "--targets", targets])
        try:
            fit = json.loads(p.stdout)
        except json.JSONDecodeError:
            report(f"fit:{name}", "FAIL", f"non-JSON output rc={p.returncode}")
            continue
        got = {k: fit.get(k) for k in ("fit_status", "fit_score", "decision_version")}
        want = {k: expect[k] for k in ("fit_status", "fit_score", "decision_version")}
        report(f"fit:{name}", "PASS" if got == want else "FAIL",
               "" if got == want else f"got {got}")

    # State writes — temp registry/events/applied only.
    state = [sys.executable, helper("state/job_state.py")]
    p1 = run(state + ["ensure-files", "--registry", registry, "--events", events])
    p2 = run(state + ["ensure-files", "--registry", registry, "--events", events])
    report("state:ensure-files-idempotent",
           "PASS" if p1.returncode == 0 and p2.returncode == 0 else "FAIL")

    rec1 = canonical.get("ashby-candidate")
    if rec1 is None:
        report("state:pipeline", "SKIP", "canonicalize failed upstream")
    else:
        rec1_json = json.dumps(rec1)
        run(state + ["upsert-job", rec1_json, "--registry", registry])
        run(state + ["upsert-job", rec1_json, "--registry", registry])
        with open(registry, encoding="utf-8") as f:
            n = len(json.load(f))
        report("state:upsert-merges", "PASS" if n == 1 else "FAIL", f"{n} records after double upsert")

        p = run(state + ["can-apply", rec1_json, "--registry", registry, "--applied", applied])
        report("state:can-apply-new", "PASS" if p.returncode == 0 else "FAIL", f"rc={p.returncode}")

        event = json.dumps({"job_key": rec1["job_key"], "status": "applied",
                            "reasoning": "conformance", "company": rec1.get("company"),
                            "title": rec1.get("title"), "url": rec1.get("url")})
        p = run(state + ["record-event", event, "--registry", registry, "--events", events])
        report("state:record-event", "PASS" if p.returncode == 0 else "FAIL", p.stderr.strip()[-120:])

        p = run(state + ["can-apply", rec1_json, "--registry", registry, "--applied", applied])
        report("state:can-apply-blocked", "PASS" if p.returncode == 2 else "FAIL", f"rc={p.returncode}")

        downgrade = json.dumps({"job_key": rec1["job_key"], "status": "new",
                                "reasoning": "conformance downgrade attempt"})
        run(state + ["record-event", downgrade, "--registry", registry, "--events", events])
        with open(registry, encoding="utf-8") as f:
            latest = json.load(f)[0].get("latest_status")
        report("state:transition-guard", "PASS" if latest == "applied" else "FAIL",
               f"latest_status={latest}")

    entry = json.dumps({"job_id": "conformance-1", "company": "GoldenCo", "title": "SWE Intern"})
    p1 = run([sys.executable, helper("state/append_state_entry.py"), applied, entry])
    p2 = run([sys.executable, helper("state/append_state_entry.py"), applied, entry])
    report("state:append-dedup",
           "PASS" if p1.returncode == 0 and p2.returncode == 2 else "FAIL",
           f"rc1={p1.returncode} rc2={p2.returncode}")

    shutil.rmtree(tmp, ignore_errors=True)


def harness_leg(harness: str) -> None:
    check = f"harness:{harness}"
    if shutil.which(harness) is None:
        report(check, "SKIP", "CLI not installed")
        return
    job = GOLDEN_JOBS[0]
    raw = json.dumps(job["raw"])
    prompt = (
        "Run exactly this one shell command from the repository root, print "
        "its full stdout verbatim, and then stop (do not do anything else): "
        f"python3 src/scripts/state/job_state.py canonicalize '{raw}'"
    )
    cmd = {
        "opencode": ["opencode", "run", prompt],
        # Scoped pre-approval for exactly the helper under test — headless
        # claude otherwise declines Bash without .claude/settings.json.
        # --allowedTools is variadic, so it must come AFTER the prompt.
        "claude": ["claude", "-p", prompt, "--allowedTools",
                   "Bash(python3 src/scripts/state/job_state.py:*)"],
        "codex": ["codex", "exec", prompt],
        "copilot": ["copilot", "-p", prompt, "--allow-all-tools"],
    }[harness]
    try:
        p = run(cmd, timeout=HARNESS_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        report(check, "FAIL", f"timed out after {HARNESS_TIMEOUT_S}s")
        return
    out = (p.stdout or "") + (p.stderr or "")
    if job["expect"]["job_key"] in out:
        report(check, "PASS")
    else:
        report(check, "FAIL", f"golden job_key not in transcript (rc={p.returncode})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--harness", choices=(*HARNESSES, "all"),
                        help="also drive the named coding-agent CLI (or 'all')")
    parser.add_argument("--skip-deterministic", action="store_true",
                        help="run only the harness leg")
    args = parser.parse_args()

    if not args.skip_deterministic:
        deterministic_leg()
    if args.harness:
        for h in HARNESSES if args.harness == "all" else (args.harness,):
            harness_leg(h)

    print(f"conformance: complete pass={PASS} fail={FAIL} skip={SKIP}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
