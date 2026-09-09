#!/usr/bin/env python3
"""Fetch Ashby, Lever, Greenhouse postings via their public JSON APIs.

Emits one raw-job JSON object per line on stdout, shaped for
`src/scripts/state/job_state.py canonicalize`.

Output contract (stdout): one JSON object per line.
Errors / warnings -> stderr.

Run:  python3 src/scripts/jobs/fetch_ats_api.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"


def load_targets():
    with open(DEFAULT_TARGETS) as fh:
        return json.load(fh)


def fetch_url(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "aplyx-job-agent/phase16b"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")


def slug_real(slugs):
    return [s for s in slugs if s and s.lower() != PLACEHOLDER]


def fetch_ashby(slug):
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
    try:
        data = fetch_url(url)
    except Exception as e:
        sys.stderr.write(f"ashby {slug}: {e}\n")
        return
    jobs = (data.get("jobs") or []) if isinstance(data, dict) else []
    for j in jobs:
        title = j.get("title") or ""
        job_url = j.get("jobUrl") or j.get("applyUrl") or ""
        loc = j.get("location") or j.get("locationName") or ""
        loc_obj = j.get("location") or {}
        if isinstance(loc_obj, dict):
            loc = loc_obj.get("name") or loc
        comp = j.get("compensation") or {}
        desc_parts = []
        if j.get("department"):
            desc_parts.append(f"Department: {j['department']}")
        if j.get("team"):
            desc_parts.append(f"Team: {j['team']}")
        if loc:
            desc_parts.append(f"Location: {loc}")
        if comp.get("compensationTierSummary"):
            desc_parts.append(f"Compensation: {comp['compensationTierSummary']}")
        # Ashby public board JSON does not include full JD body
        emit({
            "source": "ashbyhq",
            "company": slug,
            "title": title,
            "url": job_url,
            "apply_url": job_url,
            "location": loc if isinstance(loc, str) else "",
            "jd_text": " ".join(desc_parts) if desc_parts else "",
            "external_job_id": j.get("id") or "",
        })


def fetch_lever(slug):
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        data = fetch_url(url)
    except Exception as e:
        sys.stderr.write(f"lever {slug}: {e}\n")
        return
    if not isinstance(data, list):
        return
    for j in data:
        title = j.get("text") or ""
        job_url = (j.get("hostedUrl") or "").strip()
        apply_url = (j.get("applyUrl") or job_url).strip()
        cats = j.get("categories") or {}
        loc = cats.get("location") or ""
        team = cats.get("team") or ""
        commitment = cats.get("commitment") or ""
        desc_parts = []
        if team:
            desc_parts.append(f"Team: {team}")
        if commitment:
            desc_parts.append(f"Commitment: {commitment}")
        if loc:
            desc_parts.append(f"Location: {loc}")
        # Lever public JSON doesn't include descriptionPlain or description body
        emit({
            "source": "lever",
            "company": slug,
            "title": title,
            "url": job_url,
            "apply_url": apply_url,
            "location": loc,
            "jd_text": " ".join(desc_parts) if desc_parts else "",
            "external_job_id": j.get("id") or "",
        })


def fetch_greenhouse(slug):
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    try:
        data = fetch_url(url)
    except Exception as e:
        sys.stderr.write(f"greenhouse {slug}: {e}\n")
        return
    jobs = (data.get("jobs") or []) if isinstance(data, dict) else []
    for j in jobs:
        title = j.get("title") or ""
        # absolute_url is the public posting; apply_url may be empty
        job_url = (j.get("absolute_url") or "").strip()
        loc_obj = j.get("location") or {}
        loc = loc_obj.get("name") if isinstance(loc_obj, dict) else str(loc_obj or "")
        dept_list = j.get("departments") or []
        dept = dept_list[0].get("name") if dept_list and isinstance(dept_list[0], dict) else ""
        ofc_list = j.get("offices") or []
        ofc = ofc_list[0].get("name") if ofc_list and isinstance(ofc_list[0], dict) else ""
        # content is HTML body — flatten to text for JD
        content_html = j.get("content") or ""
        # Cheap HTML strip — content is well-formed XHTML in practice
        import re
        text = re.sub(r"<[^>]+>", " ", content_html)
        text = re.sub(r"\s+", " ", text).strip()
        emit({
            "source": "greenhouse",
            "company": slug,
            "title": title,
            "url": job_url,
            "apply_url": job_url,  # Greenhouse absolute_url IS the apply page
            "location": loc or ofc,
            "jd_text": text,
            "external_job_id": str(j.get("id") or ""),
        })


def main():
    targets = load_targets()
    out = {
        "ashbyhq": 0,
        "lever": 0,
        "greenhouse": 0,
    }
    slugs = {
        "ashbyhq": slug_real(targets.get("ashby_company_slugs") or []),
        "lever": slug_real(targets.get("lever_company_slugs") or []),
        "greenhouse": slug_real(targets.get("greenhouse_company_slugs") or []),
    }
    for s in slugs["ashbyhq"]:
        fetch_ashby(s)
    for s in slugs["lever"]:
        fetch_lever(s)
    for s in slugs["greenhouse"]:
        fetch_greenhouse(s)
    sys.stderr.write(
        f"fetch_ats_api: complete ashby={len(slugs['ashbyhq'])} "
        f"lever={len(slugs['lever'])} greenhouse={len(slugs['greenhouse'])}\n"
    )


if __name__ == "__main__":
    main()