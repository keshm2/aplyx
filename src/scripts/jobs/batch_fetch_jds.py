#!/usr/bin/env python3
"""Batch-fetch JDs for ATS-API-supported URLs and write a JSON map.

For each pre-filtered raw job with an API-fetchable URL, fetches its JD
text and writes a JSON file {job_key: {url, jd_text}} so the upsert step
can update each registry record with the JD.

Usage: python3 src/scripts/jobs/batch_fetch_jds.py
"""
import json
import os
import subprocess
import sys

PRE_PATH = "logs/tmp/prefiltered.jsonl"
OUT_PATH = "logs/tmp/jds_map.json"

ATS_FETCHERS = {
    "jobs.ashbyhq.com": "src/scripts/jobs/fetch_jd_for_url.py",
    "jobs.lever.co": "src/scripts/jobs/fetch_jd_for_url.py",
    "greenhouse.io": "src/scripts/jobs/fetch_jd_for_url.py",
    "oraclecloud.com": "src/scripts/jobs/fetch_jd_for_url.py",
    "myworkdayjobs.com": "src/scripts/jobs/fetch_jd_for_url.py",
    "smartrecruiters.com": "src/scripts/jobs/fetch_jd_for_url.py",
    "applytojob.com": "src/scripts/jobs/fetch_jd_for_url.py",
}


def url_kind(url):
    for needle in ATS_FETCHERS:
        if needle in url:
            return needle
    return None


def main():
    jds = {}
    urls = []
    with open(PRE_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            url = obj.get("url", "") or ""
            kind = url_kind(url)
            if not kind:
                continue
            # Stable id from URL for cross-reference with raw line
            urls.append((obj.get("company", ""), obj.get("title", ""), url, kind))
    sys.stderr.write(f"batch_fetch_jds: {len(urls)} urls to fetch\n")

    # batch by helper path to amortize startup cost
    by_helper = {}
    for company, title, url, kind in urls:
        helper = ATS_FETCHERS[kind]
        by_helper.setdefault(helper, []).append(url)

    for helper, url_list in by_helper.items():
        # Pass all urls in one call to amortize subprocess overhead
        try:
            r = subprocess.run(
                ["python3", helper] + url_list,
                capture_output=True, text=True, timeout=600,
            )
        except subprocess.TimeoutExpired:
            sys.stderr.write(f"timeout for helper {helper} with {len(url_list)} urls\n")
            r = None
        if r is None or r.returncode != 0:
            jds_for_batch = [""] * len(url_list)
            if r:
                sys.stderr.write(f"err: {r.stderr[:200]}\n")
        else:
            jds_for_batch = (r.stdout or "").split("\n")
        # Re-attach
        for url, jd in zip(url_list, jds_for_batch):
            jds[url] = (jd or "").strip()
    with open(OUT_PATH, "w") as f:
        json.dump(jds, f)
    nonzero = sum(1 for v in jds.values() if v)
    sys.stderr.write(f"batch_fetch_jds: {nonzero}/{len(jds)} urls returned jd\n")


if __name__ == "__main__":
    main()