#!/usr/bin/env python3
"""Batch upsert canonical jobs into the registry using the canonical helpers.

Loads the registry once, merges each canonical record via merge_job,
saves once at the end. Uses the same merge semantics as upsert_job but
amortizes the load/save across N records (2500+ in scrape-only mode
makes a per-record subprocess loop the dominant cost).
"""
import json
import os
import sys

sys.path.insert(0, "src/scripts/state")
import job_state  # noqa: E402

REGISTRY = "data/job_registry.json"


def main():
    in_path = sys.argv[1]
    inserted = 0
    merged = 0
    registry = job_state.load_json_array(REGISTRY)
    by_key = {}
    for rec in registry:
        by_key[rec.get("job_key")] = rec
    with open(in_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            c = json.loads(line)
            key = c.get("job_key")
            if not key:
                key = job_state.derive_job_key(c)
                c["job_key"] = key
            if key in by_key:
                job_state.merge_job(by_key[key], c)
                merged += 1
            else:
                # cross-check by natural key to fold same job across sources
                nat = job_state._find_record_by_natural_key(registry, c)
                if nat is not None:
                    job_state.merge_job(nat, c)
                    by_key[nat.get("job_key")] = nat
                    merged += 1
                else:
                    if not c.get("sources"):
                        c["sources"] = [
                            {
                                "source": c.get("source", ""),
                                "url": c.get("url", ""),
                                "external_job_id": c.get("external_job_id", ""),
                                "first_seen_at": c.get("first_seen_at", ""),
                                "last_seen_at": c.get("last_seen_at", ""),
                            }
                        ]
                    registry.append(c)
                    by_key[key] = c
                    inserted += 1
    job_state.save_json_array(REGISTRY, registry)
    print(f"inserted={inserted} merged={merged} total_in_registry={len(registry)}")


if __name__ == "__main__":
    main()