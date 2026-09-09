#!/usr/bin/env python3
"""Apply the deterministic role/level keyword prefilter to raw-job JSONL.

A job title is a candidate if it contains AT LEAST ONE term from
role_keywords AND at least one from level_keywords (case-insensitive
substring match). Outputs survivors as JSONL to stdout and a tiny
summary to stderr.

Bound the shortlist: stop emitting once the shortlist reaches max_survivors
(default 125 = 5x daily cap, min 10).
"""
import json
import re
import sys

ROLE_KEYWORDS = [
    "software engineer", "software engineering", "swe", "software developer",
    "backend engineer", "full stack engineer", "developer", "frontend engineer",
    "front end engineer", "front-end engineer", "web developer", "ui engineer",
    "react developer", "mobile engineer", "ios engineer", "android engineer",
    "mobile developer", "app developer", "machine learning", "ml engineer",
    "ai engineer", "applied ai", "applied scientist", "llm", "nlp engineer",
    "data engineer", "data engineering", "etl engineer", "analytics engineer",
    "big data engineer", "data scientist", "data science", "data analyst",
    "business analyst", "bi analyst", "network engineer", "network administrator",
    "network operations", "noc", "security engineer", "cybersecurity",
    "information security", "soc analyst", "penetration tester", "appsec",
    "security analyst", "cloud engineer", "devops engineer",
    "site reliability engineer", "infrastructure engineer", "platform engineer",
    "sre", "qa engineer", "test engineer", "sdet", "quality assurance",
    "product manager", "program manager", "technical program manager", "apm",
    "hardware engineer", "embedded engineer", "firmware engineer",
    "electrical engineer",
]
LEVEL_KEYWORDS = [
    "intern", "internship", "new grad", "new graduate", "university grad",
    "campus", "entry level", "entry-level", "junior", "early career", "associate",
]

ROLE_RE = re.compile("|".join(re.escape(k) for k in ROLE_KEYWORDS), re.IGNORECASE)
LEVEL_RE = re.compile("|".join(re.escape(k) for k in LEVEL_KEYWORDS), re.IGNORECASE)


def main():
    max_survivors = 125
    in_path = sys.argv[1] if len(sys.argv) > 1 else "logs/tmp/all_raw.jsonl"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "logs/tmp/prefiltered.jsonl"
    n_read = 0
    n_role = 0
    n_level = 0
    n_survived = 0
    n_dropped = 0
    n_bounded = 0
    with open(in_path) as inf, open(out_path, "w") as outf:
        for line in inf:
            line = line.strip()
            if not line:
                continue
            n_read += 1
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            title = obj.get("title") or ""
            matched_role = bool(ROLE_RE.search(title))
            matched_level = bool(LEVEL_RE.search(title))
            if matched_role:
                n_role += 1
            if matched_level:
                n_level += 1
            if matched_role and matched_level:
                if n_survived >= max_survivors:
                    n_bounded += 1
                    continue
                outf.write(json.dumps(obj, ensure_ascii=False) + "\n")
                n_survived += 1
            else:
                n_dropped += 1
    sys.stderr.write(
        f"prefilter: read={n_read} role_match={n_role} level_match={n_level} "
        f"survived={n_survived} dropped={n_dropped} bounded={n_bounded}\n"
    )


if __name__ == "__main__":
    main()