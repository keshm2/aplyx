#!/usr/bin/env python3
"""Normalize Ashby/Lever/Greenhouse raw API JSONL into the canonicalize input shape.

Reads raw JSONL from logs/tmp/{ashby,lever,greenhouse}.jsonl and writes
normalized JSONL to logs/tmp/normalized/{source}.jsonl with the field
shape canonicalize expects: {source, company, title, url, apply_url,
external_job_id, location, jd_text, ...}.

Also collapses duplicates within a source by URL.
"""
import json
import os
import sys

OUT = "logs/tmp/normalized"
os.makedirs(OUT, exist_ok=True)


def normalize_ashby(j):
    title = j.get("title") or ""
    company = j.get("_source_slug", "") or ""
    url = j.get("jobUrl") or ""
    apply_url = j.get("applyUrl") or url
    location = j.get("location") or ""
    if isinstance(location, dict):
        location = location.get("name") or ""
    desc = j.get("descriptionPlain") or j.get("descriptionHtml") or ""
    if isinstance(desc, str):
        # crude HTML strip
        if "<" in desc:
            import re
            desc = re.sub(r"<[^>]+>", " ", desc)
            desc = re.sub(r"\s+", " ", desc).strip()
    return {
        "source": "ashbyhq",
        "company": company,
        "title": title,
        "url": url,
        "apply_url": apply_url,
        "external_job_id": j.get("id") or "",
        "location": location,
        "jd_text": desc[:8000],
    }


def normalize_lever(j):
    title = j.get("text") or ""
    company = j.get("_source_slug", "") or ""
    url = j.get("hostedUrl") or ""
    apply_url = j.get("applyUrl") or url
    cats = j.get("categories") or {}
    if isinstance(cats, dict):
        location = cats.get("location") or cats.get("allLocations", [""])[0] if cats.get("allLocations") else cats.get("location", "")
        if isinstance(location, list):
            location = ", ".join(location)
    else:
        location = ""
    desc = j.get("descriptionPlain") or j.get("description") or ""
    if isinstance(desc, str):
        if "<" in desc:
            import re
            desc = re.sub(r"<[^>]+>", " ", desc)
            desc = re.sub(r"\s+", " ", desc).strip()
    return {
        "source": "lever",
        "company": company,
        "title": title,
        "url": url,
        "apply_url": apply_url,
        "external_job_id": j.get("id") or "",
        "location": location,
        "jd_text": desc[:8000],
    }


def normalize_greenhouse(j):
    title = j.get("title") or ""
    company = j.get("company_name") or j.get("_source_slug", "") or ""
    url = j.get("absolute_url") or ""
    apply_url = url
    loc = j.get("location") or {}
    location = loc.get("name") if isinstance(loc, dict) else (loc or "")
    desc = j.get("content") or ""
    if isinstance(desc, str) and "<" in desc:
        import re
        desc = re.sub(r"<[^>]+>", " ", desc)
        desc = re.sub(r"\s+", " ", desc).strip()
    return {
        "source": "greenhouse",
        "company": company,
        "title": title,
        "url": url,
        "apply_url": apply_url,
        "external_job_id": str(j.get("id") or j.get("internal_job_id") or ""),
        "location": location,
        "jd_text": desc[:8000],
    }


def main():
    counts = {}
    for src, fn, path in (
        ("ashbyhq", normalize_ashby, "logs/tmp/ashby.jsonl"),
        ("lever", normalize_lever, "logs/tmp/lever.jsonl"),
        ("greenhouse", normalize_greenhouse, "logs/tmp/greenhouse.jsonl"),
    ):
        out_path = os.path.join(OUT, f"{src}.jsonl")
        seen = set()
        n_in = 0
        n_out = 0
        with open(path) as f, open(out_path, "w") as o:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                n_in += 1
                try:
                    j = json.loads(line)
                except Exception:
                    continue
                norm = fn(j)
                url = norm.get("url") or ""
                if not url or not norm.get("title") or not norm.get("company"):
                    continue
                if url in seen:
                    continue
                seen.add(url)
                o.write(json.dumps(norm) + "\n")
                n_out += 1
        counts[src] = (n_in, n_out)
        print(f"{src}: in={n_in} out={n_out}", file=sys.stderr)
    print(json.dumps(counts))


if __name__ == "__main__":
    main()