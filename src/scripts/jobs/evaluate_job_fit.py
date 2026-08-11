#!/usr/bin/env python3
"""evaluate_job_fit.py — deterministic JD fit gate (Phase 4).

Evaluates one canonical job record before tailoring/application effort is spent.
The helper is deterministic, stdlib-only, and returns a machine-readable JSON
decision to stdout.

Usage:
  python3 src/scripts/jobs/evaluate_job_fit.py '<canonical-job-json>'
  python3 src/scripts/jobs/evaluate_job_fit.py '<canonical-job-json>' --targets src/config/targets.json
  python3 src/scripts/jobs/evaluate_job_fit.py -                      # read JSON from stdin

Exit codes:
  0  successful evaluation (including skipped_unfit / needs_review / candidate)
  1  input/config/usage error
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Dict, Iterable, List, Optional, Tuple


DEFAULT_TARGETS = "src/config/targets.json"
DECISION_VERSION = "phase4-v4"


# Candidate skills derived from the two shipped base resumes. The fit helper
# only awards overlap points for skills the candidate demonstrably has.
SKILL_PATTERNS: Dict[str, re.Pattern[str]] = {
    "python": re.compile(r"\bpython\b", re.I),
    "java": re.compile(r"\bjava\b", re.I),
    "c++": re.compile(r"\bc\+\+\b", re.I),
    "sql": re.compile(r"\bsql\b", re.I),
    "javascript": re.compile(r"\bjavascript\b", re.I),
    "typescript": re.compile(r"\btypescript\b", re.I),
    "docker": re.compile(r"\bdocker\b", re.I),
    "aws": re.compile(r"\baws\b|\bec2\b|\bs3\b", re.I),
    "linux": re.compile(r"\blinux\b", re.I),
    "git": re.compile(r"\bgit\b", re.I),
    "langchain": re.compile(r"\blangchain\b", re.I),
    "qdrant": re.compile(r"\bqdrant\b", re.I),
    "faiss": re.compile(r"\bfaiss\b", re.I),
    "streamlit": re.compile(r"\bstreamlit\b", re.I),
    "rag": re.compile(r"\brag\b|retrieval augmented", re.I),
    "llm": re.compile(r"\bllm\b|large language model", re.I),
    "networking": re.compile(r"\bnetwork(?:ing)?\b|\btcp/ip\b", re.I),
    "dhcp": re.compile(r"\bdhcp\b", re.I),
    "ospf": re.compile(r"\bospf\b", re.I),
    "wireshark": re.compile(r"\bwireshark\b", re.I),
    "security": re.compile(r"\bsecurity\b|\bappsec\b|\bcybersecurity\b", re.I),
    "ci/cd": re.compile(r"\bci/?cd\b", re.I),
}

WELCOME_PATTERNS = re.compile(
    r"(?:\bnew\s*grad(?:uate)?\b|\brecent\s*grad(?:uate)?\b|\bentry[\s-]?level\b|"
    r"\bearly\s+career\b|\bcampus\b|\bintern(?:ship)?\b|\bco[\s-]?op\b|"
    r"\bno\s+(?:prior|previous)?\s*(?:work|industry|professional)?\s*(?:experience|exp)\s+required\b|"
    r"\bwelcome[sd]?\s+to\s+apply\b|\bencouraged\s+to\s+apply\b)",
    re.I,
)

YOE_RANGE_RE = re.compile(
    r"(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(?:years?|yrs?|yr)\b[^\n.]{0,40}?\b(?:experience|exp)\b",
    re.I,
)
YOE_SIMPLE_RE = re.compile(
    r"(?<![a-z])(\d{1,2})\s*\+?\s*(?:years?|yrs?|yr)\b[^\n.]{0,40}?\b(?:experience|exp)\b",
    re.I,
)
YOE_MIN_RE = re.compile(
    r"(?:at\s+least|minimum\s+of|minimum)\s+(\d{1,2})\s*(?:years?|yrs?|yr)\b",
    re.I,
)

PREFERRED_SECTION_RE = re.compile(
    r"(?:^|\n)\s*(?:preferred|nice\s+to\s+have|bonus|desired|additional)\s+qualifications?\b",
    re.I,
)

ADVANCED_DEGREE_REQUIRED_RE = re.compile(
    r"(?:master'?s|ms\b|phd|ph\.d\.|doctorate|doctoral|graduate\s+degree)[^\n.]{0,80}"
    r"(?:required|must|need|minimum|requisite)",
    re.I,
)
ADVANCED_DEGREE_ALLOWED_RE = re.compile(
    r"(?:pursuing|in\s+progress|currently\s+enrolled|or\s+equivalent|equivalent\s+experience|"
    r"bachelor'?s)",
    re.I,
)

CLEARANCE_REQUIRED_RE = re.compile(
    r"(?:ts/sci|top\s+secret|secret\s+clearance|active\s+clearance|security\s+clearance\s+required|"
    r"must\s+(?:hold|possess|have)\s+(?:an\s+)?(?:active\s+)?clearance)",
    re.I,
)
CLEARANCE_OBTAINABLE_RE = re.compile(
    r"(?:eligible\s+to\s+obtain|ability\s+to\s+obtain|able\s+to\s+obtain)",
    re.I,
)

VISA_ONLY_RE = re.compile(
    r"(?:must\s+be\s+on\s+(?:opt|cpt|f-1|f1)|only\s+(?:opt|cpt|f-1|f1)|"
    r"opt/cpt\s+required|f-1\s+visa\s+required|student\s+visa\s+required)",
    re.I,
)

REMOTE_US_RE = re.compile(r"remote[^\n,;]*\b(?:us|u\.s\.?|usa|united\s+states)\b", re.I)
REMOTE_GENERIC_RE = re.compile(r"\bremote\b|work\s+from\s+home|virtual", re.I)

US_STATE_TOKENS = {
    "al", "alabama", "ak", "alaska", "az", "arizona", "ar", "arkansas",
    "ca", "california", "co", "colorado", "ct", "connecticut", "de", "delaware",
    "dc", "district of columbia", "fl", "florida", "ga", "georgia", "hi", "hawaii",
    "id", "idaho", "il", "illinois", "in", "indiana", "ia", "iowa", "ks", "kansas",
    "ky", "kentucky", "la", "louisiana", "me", "maine", "md", "maryland", "ma", "massachusetts",
    "mi", "michigan", "mn", "minnesota", "ms", "mississippi", "mo", "missouri", "mt", "montana",
    "ne", "nebraska", "nv", "nevada", "nh", "new hampshire", "nj", "new jersey", "nm", "new mexico",
    "ny", "new york", "nc", "north carolina", "nd", "north dakota", "oh", "ohio", "ok", "oklahoma",
    "or", "oregon", "pa", "pennsylvania", "ri", "rhode island", "sc", "south carolina",
    "sd", "south dakota", "tn", "tennessee", "tx", "texas", "ut", "utah", "vt", "vermont",
    "va", "virginia", "wa", "washington", "wv", "west virginia", "wi", "wisconsin", "wy", "wyoming",
    "pr", "puerto rico", "usa", "united states", "u.s.", "u.s.a.",
}

FOREIGN_LOCATION_RE = re.compile(
    r"\b(?:uk|united\s+kingdom|canada|toronto|vancouver|ontario|berlin|germany|india|"
    r"australia|sydney|singapore|ireland|dublin|netherlands|amsterdam|france|paris|"
    r"spain|barcelona|mexico|brazil|japan|tokyo|china|hong\s+kong)\b",
    re.I,
)


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def error(message: str, **extra: object) -> None:
    payload = {"ok": False, "error": message}
    payload.update(extra)
    emit(payload)
    sys.exit(1)


def load_json_arg(arg: str) -> dict:
    raw = sys.stdin.read() if arg == "-" else arg
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        error(f"input is not valid JSON: {exc.msg}")
    if not isinstance(obj, dict):
        error(f"expected a JSON object, got {type(obj).__name__}")
    return obj


def load_json_array_arg(arg: str) -> list:
    """Same as load_json_arg but for a JSON array — used by --batch."""
    raw = sys.stdin.read() if arg == "-" else arg
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        error(f"input is not valid JSON: {exc.msg}")
    if not isinstance(obj, list):
        error(f"expected a JSON array, got {type(obj).__name__}")
    return obj


def load_targets(path: str) -> dict:
    if not os.path.exists(path):
        error(f"targets config not found: {path}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        error(f"could not read targets config {path}: {exc}")
    if not isinstance(data, dict):
        error(f"targets config must be a JSON object, got {type(data).__name__}")
    for key in ("role_keywords", "level_keywords", "preferred_locations", "fallback_scope"):
        if key not in data:
            error(f"targets config missing required field '{key}'")
    if not isinstance(data.get("role_keywords"), list) or not data["role_keywords"]:
        error("targets config field 'role_keywords' must be a non-empty array")
    if not isinstance(data.get("level_keywords"), list) or not data["level_keywords"]:
        error("targets config field 'level_keywords' must be a non-empty array")
    return data


def pick_text(obj: dict, *keys: str) -> str:
    for key in keys:
        val = obj.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def contains_token(text: str, token: str) -> bool:
    text_lower = text.lower()
    token_lower = token.lower().strip()
    if not token_lower:
        return False
    pattern = re.escape(token_lower).replace(r"\ ", r"\s+")
    if re.match(r"[a-z0-9]", token_lower[0]):
        pattern = r"\b" + pattern
    if re.match(r".*[a-z0-9]$", token_lower):
        pattern = pattern + r"\b"
    return re.search(pattern, text_lower) is not None


def find_first_keyword(text: str, keywords: Iterable[str]) -> str:
    text = text.lower()
    for kw in keywords:
        if contains_token(text, kw):
            return kw
    return ""


def split_requirements_text(jd_text: str) -> str:
    if not jd_text:
        return ""
    parts = PREFERRED_SECTION_RE.split(jd_text, maxsplit=1)
    return parts[0]


def sentence_window(text: str, start: int, end: int) -> str:
    """Return a best-effort sentence/clause window around a match span."""
    if not text:
        return ""
    left_candidates = [text.rfind(sep, 0, start) for sep in ("\n", ". ", "; ")]
    left = max(left_candidates)
    left = 0 if left == -1 else left + 1

    right_positions = [pos for pos in (text.find("\n", end), text.find(". ", end), text.find("; ", end)) if pos != -1]
    right = min(right_positions) if right_positions else len(text)
    return text[left:right].strip()


def has_welcoming_language(title: str, jd_text: str, role_type: str, internship_term: str) -> bool:
    combined = " ".join([title or "", jd_text or "", role_type or "", internship_term or ""])
    return bool(WELCOME_PATTERNS.search(combined))


def parse_years_required(title: str, jd_text: str, role_type: str, internship_term: str) -> Optional[int]:
    title_lower = (title or "").lower()
    if re.search(r"\b(?:intern|internship|co[\s-]?op|coop)\b", title_lower):
        return None
    if re.search(r"\b(?:entry[\s-]?level|new\s*grad(?:uate)?|campus|university\s+grad)\b", title_lower):
        return None
    if has_welcoming_language(title, jd_text, role_type, internship_term):
        return None

    requirements = split_requirements_text(jd_text or "")
    max_years: Optional[int] = None
    for match in YOE_RANGE_RE.finditer(requirements):
        years = int(match.group(2))
        max_years = years if max_years is None else max(max_years, years)
    for regex in (YOE_SIMPLE_RE, YOE_MIN_RE):
        for match in regex.finditer(requirements):
            years = int(match.group(1))
            max_years = years if max_years is None else max(max_years, years)
    return max_years


def advanced_degree_required(jd_text: str) -> bool:
    if not jd_text:
        return False
    match = ADVANCED_DEGREE_REQUIRED_RE.search(jd_text)
    if not match:
        return False
    clause = sentence_window(jd_text, match.start(), match.end())
    return not ADVANCED_DEGREE_ALLOWED_RE.search(clause)


def clearance_required(jd_text: str) -> bool:
    if not jd_text:
        return False
    match = CLEARANCE_REQUIRED_RE.search(jd_text)
    if not match:
        return False
    clause = sentence_window(jd_text, match.start(), match.end())
    return not CLEARANCE_OBTAINABLE_RE.search(clause)


def visa_only_required(jd_text: str) -> bool:
    return bool(jd_text and VISA_ONLY_RE.search(jd_text))


def explicit_non_us_location(location: str, location_tier: str) -> bool:
    loc = normalize_text(location).lower()
    if not loc:
        return False
    if location_tier in {"preferred", "fallback"}:
        return False
    if REMOTE_US_RE.search(loc):
        return False
    if REMOTE_GENERIC_RE.search(loc) and not FOREIGN_LOCATION_RE.search(loc):
        return False
    if any(contains_token(loc, token) for token in US_STATE_TOKENS):
        return False
    return bool(FOREIGN_LOCATION_RE.search(loc))


def infer_location_signal(location: str, location_tier: str) -> Tuple[int, str]:
    loc = normalize_text(location).lower()
    if location_tier == "preferred":
        return 15, "preferred location matched"
    if location_tier == "fallback":
        return 8, "within US fallback scope"
    if REMOTE_US_RE.search(loc):
        return 12, "remote-US role"
    if REMOTE_GENERIC_RE.search(loc):
        return 9, "remote role"
    if any(contains_token(loc, token) for token in US_STATE_TOKENS):
        return 6, "US-based location"
    return 0, "location ambiguous"


def matched_skills(jd_text: str) -> List[str]:
    matches: List[str] = []
    for skill, pattern in SKILL_PATTERNS.items():
        if pattern.search(jd_text or ""):
            matches.append(skill)
    return matches


def summarize_reasoning(status: str, reasons: List[str], score: int) -> str:
    if reasons:
        if status == "skipped_unfit":
            return reasons[0]
        if status == "needs_review":
            return f"Ambiguous fit: {reasons[0].rstrip('.')}; manual review recommended."
    if status == "candidate":
        return f"Fit gate passed with score {score}/100 and no deterministic hard reject."
    if status == "needs_review":
        return f"Fit gate produced a borderline score of {score}/100; manual review recommended."
    return f"Deterministic fit gate rejected the job with score {score}/100."


def evaluate_fit(job: dict, targets: dict) -> dict:
    title = normalize_text(pick_text(job, "title"))
    # Keep an un-normalized copy for the section/sentence-aware detectors:
    # the preferred-qualifications splitter and sentence_window need the
    # original newlines that normalize_text collapses away.
    jd_raw = pick_text(job, "jd_text", "description", "job_description")
    jd_text = normalize_text(jd_raw)
    location = normalize_text(pick_text(job, "location"))
    role_type = normalize_text(pick_text(job, "role_type"))
    internship_term = normalize_text(pick_text(job, "internship_term"))
    location_tier = normalize_text(pick_text(job, "location_tier"))

    if not title:
        error("canonical job missing required field 'title'")
    if not pick_text(job, "company"):
        error("canonical job missing required field 'company'")

    role_keywords = [str(v) for v in targets.get("role_keywords", [])]
    level_keywords = [str(v) for v in targets.get("level_keywords", [])]
    # Opt-in, defaults to False so an operator who has never touched the
    # Settings Levels submenu keeps today's exact intern/new-grad-only
    # behavior. Set by the "Full time (3+ yrs exp)" level checkbox — see
    # src/tui/src/data/levelCategories.ts. Relaxes the two experience-based
    # hard rejects below; every other gate (role match, US location,
    # advanced degree, clearance, visa) still applies unchanged.
    allow_experienced_roles = bool(targets.get("allow_experienced_roles", False))

    title_lower = title.lower()
    jd_lower = jd_text.lower()

    matched_role_keyword = find_first_keyword(title_lower, role_keywords)
    role_source = "title" if matched_role_keyword else ""
    if not matched_role_keyword:
        matched_role_keyword = find_first_keyword(jd_lower, role_keywords)
        role_source = "jd" if matched_role_keyword else ""

    matched_level_keyword = find_first_keyword(title_lower, level_keywords)
    matched_level_source = "title" if matched_level_keyword else ""
    if not matched_level_keyword:
        matched_level_keyword = find_first_keyword(jd_lower, level_keywords)
        matched_level_source = "jd" if matched_level_keyword else ""

    years_required = parse_years_required(title, jd_raw, role_type, internship_term)
    fit_reasons: List[str] = []

    # Deterministic hard rejects first.
    if not matched_role_keyword:
        fit_reasons.append("No configured role keyword matched the title or JD.")
        return build_result(
            fit_status="skipped_unfit",
            fit_score=0,
            fit_reasons=fit_reasons,
            matched_role_keyword="",
            matched_level_keyword=matched_level_keyword,
            matched_level_source=matched_level_source,
            years_required=years_required,
        )

    welcoming = has_welcoming_language(title, jd_text, role_type, internship_term)
    if years_required is not None and years_required >= 3 and not welcoming and not allow_experienced_roles:
        fit_reasons.append(f"JD requires {years_required}+ years of experience without clear intern/new-grad language.")
        return build_result(
            fit_status="skipped_unfit",
            fit_score=10,
            fit_reasons=fit_reasons,
            matched_role_keyword=matched_role_keyword,
            matched_level_keyword=matched_level_keyword,
            matched_level_source=matched_level_source,
            years_required=years_required,
        )

    if explicit_non_us_location(location, location_tier):
        fit_reasons.append("Job location is explicitly outside the United States with no remote-US option.")
        return build_result(
            fit_status="skipped_unfit",
            fit_score=10,
            fit_reasons=fit_reasons,
            matched_role_keyword=matched_role_keyword,
            matched_level_keyword=matched_level_keyword,
            matched_level_source=matched_level_source,
            years_required=years_required,
        )

    if advanced_degree_required(jd_raw):
        fit_reasons.append("JD requires a Master's/PhD level degree without a pursuing/in-progress exception.")
        return build_result(
            fit_status="skipped_unfit",
            fit_score=15,
            fit_reasons=fit_reasons,
            matched_role_keyword=matched_role_keyword,
            matched_level_keyword=matched_level_keyword,
            matched_level_source=matched_level_source,
            years_required=years_required,
        )

    if clearance_required(jd_raw):
        fit_reasons.append("JD requires an active security clearance rather than only the ability to obtain one.")
        return build_result(
            fit_status="skipped_unfit",
            fit_score=15,
            fit_reasons=fit_reasons,
            matched_role_keyword=matched_role_keyword,
            matched_level_keyword=matched_level_keyword,
            matched_level_source=matched_level_source,
            years_required=years_required,
        )

    if visa_only_required(jd_text):
        fit_reasons.append("JD explicitly requires OPT/CPT/F-1 status.")
        return build_result(
            fit_status="skipped_unfit",
            fit_score=15,
            fit_reasons=fit_reasons,
            matched_role_keyword=matched_role_keyword,
            matched_level_keyword=matched_level_keyword,
            matched_level_source=matched_level_source,
            years_required=years_required,
        )

    # If the role matched but there is no level signal at all, this is still
    # likely not an internship/new-grad role in the current pipeline —
    # UNLESS the operator has opted into experienced/full-time roles
    # (allow_experienced_roles), in which case a role is allowed through
    # without needing an explicit junior/level signal at all.
    if (
        not matched_level_keyword
        and not role_type
        and not internship_term
        and not welcoming
        and not allow_experienced_roles
    ):
        fit_reasons.append("No internship/new-grad signal was found in the title or JD.")
        return build_result(
            fit_status="skipped_unfit",
            fit_score=20,
            fit_reasons=fit_reasons,
            matched_role_keyword=matched_role_keyword,
            matched_level_keyword="",
            matched_level_source="",
            years_required=years_required,
        )

    # Deterministic scoring.
    score = 0
    if role_source == "title":
        score += 35
        fit_reasons.append(f"Role keyword '{matched_role_keyword}' matched in the title.")
    else:
        score += 20
        fit_reasons.append(f"Role keyword '{matched_role_keyword}' matched in the JD.")

    if matched_level_source == "title":
        score += 20
        fit_reasons.append(f"Level keyword '{matched_level_keyword}' matched in the title.")
    elif matched_level_source == "jd":
        score += 10
        fit_reasons.append(f"Level keyword '{matched_level_keyword}' matched in the JD.")
    elif welcoming or role_type or internship_term:
        score += 6
        fit_reasons.append("Intern/new-grad intent is implied, but not stated with a configured level keyword.")

    # Location is a preference signal only: it contributes to the reported
    # fit_score (used for sorting/display) but never to core_score, which
    # is what the status thresholds below gate on. A strong candidate in a
    # non-preferred location shouldn't be demoted, and a weak candidate
    # shouldn't be promoted, purely by a location bonus/penalty.
    location_points, location_reason = infer_location_signal(location, location_tier)
    fit_reasons.append(location_reason + ".")

    matched_skill_list = matched_skills(jd_text)
    skill_points = min(20, len(matched_skill_list) * 4)
    score += skill_points
    if matched_skill_list:
        fit_reasons.append("Matched JD skills: " + ", ".join(matched_skill_list[:6]) + ".")
    else:
        fit_reasons.append("No strong overlap with the candidate's common technical skills was found in the JD.")

    if years_required is None:
        score += 10
        fit_reasons.append("No deterministic 3+ years requirement was detected.")
    elif years_required <= 2:
        score += 8
        fit_reasons.append(f"Years-of-experience requirement is within early-career range ({years_required}).")
    else:
        score += 4
        fit_reasons.append(f"Years-of-experience requirement is present ({years_required}) but softened by intern/new-grad language.")

    if "bachelor" in jd_lower or "pursuing" in jd_lower or "undergraduate" in jd_lower:
        score += 5
        fit_reasons.append("Degree language is compatible with the candidate's current undergraduate status.")
    else:
        score += 3

    core_score = max(0, min(100, int(score)))
    fit_score = max(0, min(100, int(score + location_points)))

    if core_score < 70:
        status = "skipped_unfit"
    elif core_score < 75:
        status = "needs_review"
    else:
        status = "candidate"

    # Ambiguous but promising: if role match is only in JD body or level is only implied,
    # prefer manual review unless the score is very strong.
    if status == "candidate" and core_score < 75:
        weak_role = role_source == "jd"
        weak_level = not matched_level_keyword
        if weak_role or weak_level:
            status = "needs_review"
            if weak_role:
                fit_reasons.append("Role match appears only in the JD body, so manual review is safer.")
            if weak_level:
                fit_reasons.append("Level signal is implied rather than explicit, so manual review is safer.")

    return build_result(
        fit_status=status,
        fit_score=fit_score,
        fit_reasons=fit_reasons,
        matched_role_keyword=matched_role_keyword,
        matched_level_keyword=matched_level_keyword,
        matched_level_source=matched_level_source,
        years_required=years_required,
    )


def build_result(
    *,
    fit_status: str,
    fit_score: int,
    fit_reasons: List[str],
    matched_role_keyword: str,
    matched_level_keyword: str,
    matched_level_source: str,
    years_required: Optional[int],
) -> dict:
    return {
        "ok": True,
        "fit_status": fit_status,
        "fit_score": int(fit_score),
        "reasoning": summarize_reasoning(fit_status, fit_reasons, int(fit_score)),
        "fit_reasons": fit_reasons,
        "matched_role_keyword": matched_role_keyword,
        "matched_level_keyword": matched_level_keyword,
        "matched_level_source": matched_level_source,
        "years_required": years_required,
        "decision_version": DECISION_VERSION,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="evaluate_job_fit.py",
        description="Deterministic JD fit gate for internship/new-grad automation.",
    )
    parser.add_argument("job_json", help="Canonical job JSON object, or a JSON array with --batch (either, or '-' for stdin)")
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument(
        "--batch", action="store_true",
        help="job_json is a JSON array of canonical jobs; evaluate all of them in one "
             "process (JSONL output, one result per line, in input order) instead of "
             "one process per job — added for src/worker/'s hosted pipeline (Phase 17), "
             "which was spawning one interpreter per candidate job at real scale.",
    )
    args = parser.parse_args(argv)

    targets = load_targets(args.targets)

    if args.batch:
        jobs = load_json_array_arg(args.job_json)
        for job in jobs:
            if not isinstance(job, dict):
                # One malformed item shouldn't cost the rest of the batch —
                # emit an inline error result (same {"ok": False, "error"}
                # shape a single-job error() call would print) and continue,
                # rather than exiting the whole process.
                print(json.dumps({"ok": False, "error": f"batch item is not an object, got {type(job).__name__}"}))
                continue
            try:
                result = evaluate_fit(job, targets)
            except SystemExit:
                # evaluate_fit() itself calls error() (JSON + sys.exit) on a
                # job missing title/company — same per-item tolerance as
                # canonicalize-batch, so one bad item can't silently cost
                # the whole batch's results.
                print(json.dumps({"ok": False, "error": "evaluate_fit failed for this item (missing required field)"}))
                continue
            print(json.dumps(result, ensure_ascii=False))
        return 0

    job = load_json_arg(args.job_json)
    result = evaluate_fit(job, targets)
    emit(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
