#!/usr/bin/env python3
"""Fetch JD body for a single URL via the right ATS API helper.

Uses Ashby/Lever/Greenhouse direct JSON APIs (no helper needed) for those
families; shells out to the existing per-platform helpers for Oracle,
Workday, SmartRecruiters, JazzHR.

Usage: python3 src/scripts/jobs/fetch_jd_for_url.py <url>
Prints the JD text on stdout (or empty string + non-zero exit on failure).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request

USER_AGENT = "aplyx-job-agent/phase16b"


def fetch_url(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def jd_from_ashby(job_url):
    # job_url like https://jobs.ashbyhq.com/<slug>/<id>
    m = re.match(r"https?://jobs\.ashbyhq\.com/([^/]+)/([^/?#]+)", job_url)
    if not m:
        return ""
    slug, jid = m.group(1), m.group(2)
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
    try:
        data = fetch_url(url)
    except Exception:
        return ""
    for j in (data.get("jobs") or []):
        if j.get("id") == jid or j.get("shortId") == jid:
            parts = []
            if j.get("department"):
                parts.append(f"Department: {j['department']}")
            if j.get("team"):
                parts.append(f"Team: {j['team']}")
            if j.get("location"):
                loc = j["location"]
                if isinstance(loc, dict):
                    loc = loc.get("name", "")
                parts.append(f"Location: {loc}")
            if j.get("descriptionPlain"):
                parts.append(j["descriptionPlain"])
            elif j.get("description"):
                # strip HTML
                parts.append(re.sub(r"<[^>]+>", " ", j["description"]))
            elif j.get("jobPosting"):
                parts.append(re.sub(r"<[^>]+>", " ", j["jobPosting"]))
            return "\n".join(parts).strip()
    return ""


def jd_from_lever(apply_url):
    # apply_url like https://jobs.lever.co/<slug>/<id>/apply
    m = re.match(r"https?://jobs\.lever\.co/([^/]+)/([^/?#]+)(?:/apply)?", apply_url)
    if not m:
        return ""
    slug, jid = m.group(1), m.group(2)
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        data = fetch_url(url)
    except Exception:
        return ""
    for j in data:
        if j.get("id") == jid:
            desc = j.get("descriptionPlain") or j.get("description") or ""
            return re.sub(r"<[^>]+>", " ", desc).strip()
    return ""


def jd_from_greenhouse(job_url):
    # job_url like https://job-boards.greenhouse.io/<slug>/jobs/<id> or
    # https://boards.greenhouse.io/<slug>/jobs/<id>
    m = re.match(r"https?://(?:job-boards|boards)\.greenhouse\.io/([^/]+)/jobs/(\d+)", job_url)
    if not m:
        return ""
    slug, jid = m.group(1), m.group(2)
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jid}?questions=false"
    try:
        data = fetch_url(url)
    except Exception:
        return ""
    content = (data.get("content") or "") if isinstance(data, dict) else ""
    text = re.sub(r"<[^>]+>", " ", content)
    return re.sub(r"\s+", " ", text).strip()


def jd_from_helper(helper_path, url, extra_args=None):
    """Shell out to fetch_<family>_listings.py --jd-url <url>"""
    args = ["python3", helper_path, "--jd-url", url]
    if extra_args:
        args.extend(extra_args)
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return ""
    if r.returncode != 0:
        return ""
    out = (r.stdout or "").strip()
    if not out:
        return ""
    try:
        obj = json.loads(out)
    except json.JSONDecodeError:
        # helper might emit NDJSON
        lines = [l for l in out.split("\n") if l.strip()]
        if lines:
            try:
                obj = json.loads(lines[-1])
            except json.JSONDecodeError:
                return ""
        else:
            return ""
    return obj.get("jd_text") or obj.get("description") or obj.get("description_text") or ""


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: fetch_jd_for_url.py <url> [url2 ...]\n")
        sys.exit(2)
    for url in sys.argv[1:]:
        jd = ""
        if "jobs.ashbyhq.com" in url:
            jd = jd_from_ashby(url)
        elif "jobs.lever.co" in url:
            jd = jd_from_lever(url)
        elif "greenhouse.io" in url:
            jd = jd_from_greenhouse(url)
        elif "oraclecloud.com" in url:
            jd = jd_from_helper("src/scripts/jobs/fetch_oracle_listings.py", url)
        elif "myworkdayjobs.com" in url:
            jd = jd_from_helper("src/scripts/jobs/fetch_workday_listings.py", url)
        elif "smartrecruiters.com" in url:
            jd = jd_from_helper("src/scripts/jobs/fetch_smartrecruiters_listings.py", url)
        elif "applytojob.com" in url:
            jd = jd_from_helper("src/scripts/jobs/fetch_jazzhr_listings.py", url)
        print(jd)


if __name__ == "__main__":
    main()