#!/usr/bin/env python3
"""publish_release_manifest.py: upsert the integrity manifest to Supabase.

Run in CI on a tagged release (desktop-release.yml), holding
SUPABASE_SECRET_KEY (service_role) and SUPABASE_URL as env vars only. This
publishes the per-version file hashes to the `release_manifests` table
(migration 0044) so a local client can verify against a copy it cannot
forge — a client only holds the anon key, and `release_manifests` has no
authenticated write policy.

  SUPABASE_URL=... SUPABASE_SECRET_KEY=sb_secret_... \
    python3 src/scripts/validate/publish_release_manifest.py

The bundled src/integrity/manifest.json keeps working offline regardless;
this is the stronger root of trust when the client is online.

Exit codes: 0 ok; 1 missing env / manifest / HTTP error.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

MANIFEST_PATH = "src/integrity/manifest.json"


def main() -> int:
    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("publish_release_manifest: SUPABASE_URL and SUPABASE_SECRET_KEY are required", file=sys.stderr)
        return 1

    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"publish_release_manifest: cannot read {MANIFEST_PATH}: {exc}", file=sys.stderr)
        return 1

    version = manifest.get("version")
    if not version or version == "unknown":
        print(f"publish_release_manifest: manifest has no usable version ({version!r})", file=sys.stderr)
        return 1

    body = json.dumps({
        "version": version,
        "files": manifest.get("files", {}),
        "forbidden": manifest.get("forbidden", []),
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{url}/rest/v1/release_manifests?on_conflict=version",
        data=body,
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status not in (200, 201, 204):
                print(f"publish_release_manifest: HTTP {resp.status}", file=sys.stderr)
                return 1
    except urllib.error.HTTPError as exc:
        print(f"publish_release_manifest: HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:300]}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"publish_release_manifest: {exc}", file=sys.stderr)
        return 1

    print(f"publish_release_manifest: published version {version} ({len(manifest.get('files', {}))} files)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
