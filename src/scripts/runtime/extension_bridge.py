#!/usr/bin/env python3
"""extension_bridge.py — localhost bridge for the aplyx browser extension (Phase 10).

The Manifest V3 extension never touches state files directly. Every read
and write flows through this bridge, and the bridge itself only shells
out to the repo's deterministic helpers:

  - src/scripts/state/job_state.py       (canonicalize / upsert-job / can-apply / record-event)
  - src/scripts/jobs/evaluate_job_fit.py (the phase 4 deterministic fit gate)
  - src/scripts/state/append_state_entry.py (atomic appends with the job_id dedup guard)
  - src/scripts/jobs/sync_internship_tracker.py (best-effort Sheets sync, applied only)

Security model:
  - Binds to 127.0.0.1 only. Never a public interface.
  - Requires a per-install bearer token on every request. The token is
    generated on first start into src/config/extension_bridge.json
    (gitignored, chmod 600) and pasted once into the extension options.
  - /fields returns only the safe_fields keys the extension explicitly
    asks for (the fields it is about to fill) — never the whole map.
  - The bridge never auto-submits anything; it records outcomes the
    user reports after submitting a form themselves.

src/tui/src/profileLinks.ts is the TS twin of the extract_username/
derive_full_url helpers below — kept in sync by hand, same as
src/tui/src/resumes.ts's EXPECTED_RESUMES.

Usage:
  python src/scripts/runtime/extension_bridge.py             # start (default port from config)
  python src/scripts/runtime/extension_bridge.py --port N    # override the port
  python src/scripts/runtime/extension_bridge.py --show-token

Endpoints (Authorization: Bearer <token> required on all):
  GET  /health      -> {ok, service, version}
  GET  /field-keys  -> {ok, keys: [...]}          (names only, no values)
  POST /fit         -> canonicalize + upsert + fit gate + can-apply
  POST /fields      -> {ok, fields: {key: value}} (requested keys only)
  POST /outcome     -> record applied / needs_review through the helpers
"""

import argparse
import hmac
import json
import os
import re
import secrets
import stat
import subprocess
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "phase10-v1"
DEFAULT_PORT = 8377
MAX_BODY_BYTES = 2 * 1024 * 1024
PLACEHOLDER_VALUES = {"", "replace_me"}

# The four ATS form families the extension supports (phase 10 scope).
ALLOWED_SOURCES = {"greenhouse", "lever", "ashbyhq", "workday"}
ALLOWED_OUTCOMES = {"applied", "needs_review"}

# Keys the extension may ever request. Mirrors the safe_fields contract:
# these are the only values ever typed into application forms.
SAFE_FIELD_KEYS = {
    "first_name",
    "last_name",
    "preferred_name",
    "email",
    "phone",
    "linkedin_username",
    "github_username",
    "linkedin_url",
    "github_url",
    "location",
    "zip_code",
    "address_line1",
    "address_line2",
    "graduation_date",
    "gpa",
    "authorized_to_work",
    "require_sponsorship",
    "citizenship_status",
    "currently_enrolled",
    # Deliberately NOT here: gender, ethnicity, hispanic_or_latino,
    # date_of_birth, veteran_status, disability_status. The extension's
    # regex-based field detection (ats.ts) has no equivalent to the main
    # apply agent's pre-submit field-by-field verification (AGENTS.md) —
    # EEO/demographic answers only ever go out through that stricter path.
}

_HOST_PREFIX = {
    "linkedin": re.compile(r"^linkedin\.com/in/", re.IGNORECASE),
    "github": re.compile(r"^github\.com/", re.IGNORECASE),
}


def extract_username(kind: str, raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    value = re.sub(r"^https?://", "", value, flags=re.IGNORECASE)
    value = re.sub(r"^www\.", "", value, flags=re.IGNORECASE)
    value = _HOST_PREFIX[kind].sub("", value)
    value = re.split(r"[?#]", value)[0]
    return value.rstrip("/")


def derive_full_url(kind: str, username: str) -> str:
    if not username:
        return ""
    host = "linkedin.com/in" if kind == "linkedin" else "github.com"
    return f"https://{host}/{username}"


NEW_GRAD_TERMS = (
    "new grad", "new graduate", "entry level", "entry-level", "associate",
    "junior", "early career", "university grad", "campus",
)


def project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


ROOT = project_root()
BRIDGE_CONFIG = os.path.join(ROOT, "src", "config", "extension_bridge.json")


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{stamp}] extension_bridge: {message}", file=sys.stderr, flush=True)


def load_or_create_bridge_config() -> dict:
    """Per-install token + port. Created once, chmod 600, gitignored."""
    if os.path.exists(BRIDGE_CONFIG):
        with open(BRIDGE_CONFIG, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        if not isinstance(cfg.get("token"), str) or len(cfg["token"]) < 32:
            raise SystemExit(
                f"extension_bridge: {BRIDGE_CONFIG} has no usable token — delete the file and restart to regenerate."
            )
        return cfg
    cfg = {"port": DEFAULT_PORT, "token": secrets.token_hex(32)}
    tmp = f"{BRIDGE_CONFIG}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(tmp, BRIDGE_CONFIG)
    log(f"generated new bridge token in {BRIDGE_CONFIG}")
    return cfg


def run_helper(argv: list, input_text: str = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        cwd=ROOT,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=120,
    )


def py_helper(*args: str) -> list[str]:
    return [sys.executable, *args]


def helper_json(argv: list) -> dict:
    proc = run_helper(argv)
    if proc.returncode != 0:
        raise RuntimeError(
            f"{argv[1] if len(argv) > 1 else argv[0]} failed (rc={proc.returncode}): {proc.stderr.strip()[-400:]}"
        )
    return json.loads(proc.stdout)


def read_safe_fields() -> dict:
    with open(os.path.join(ROOT, "src", "config", "targets.json"), "r", encoding="utf-8") as fh:
        targets = json.load(fh)
    fields = targets.get("safe_fields") or {}
    usable = {}
    for key, value in fields.items():
        if key not in SAFE_FIELD_KEYS:
            continue
        text = str(value).strip()
        if text.lower() in PLACEHOLDER_VALUES:
            continue
        usable[key] = text
    return usable


def read_preferred_locations() -> list:
    try:
        with open(os.path.join(ROOT, "src", "config", "targets.json"), "r", encoding="utf-8") as fh:
            targets = json.load(fh)
        return [str(loc) for loc in (targets.get("preferred_locations") or [])]
    except (OSError, json.JSONDecodeError):
        return []


def role_type(title: str) -> str:
    lowered = title.lower()
    return "new_grad" if any(term in lowered for term in NEW_GRAD_TERMS) else "internship"


def location_tier(location: str) -> str:
    lowered = (location or "").lower()
    for preferred in read_preferred_locations():
        value = preferred.lower()
        if value and value in lowered:
            return "preferred"
    return "fallback"


def validate_job(payload: dict) -> dict:
    job = payload.get("job")
    if not isinstance(job, dict):
        raise ValueError("body must include a 'job' object")
    for field in ("source", "company", "title", "url"):
        if not str(job.get(field, "")).strip():
            raise ValueError(f"job.{field} is required")
    if job["source"] not in ALLOWED_SOURCES:
        raise ValueError(f"job.source must be one of {sorted(ALLOWED_SOURCES)}")
    return job


def canonicalize_and_upsert(job: dict) -> dict:
    canonical = helper_json(py_helper("src/scripts/state/job_state.py", "canonicalize", json.dumps(job)))
    helper_json(py_helper("src/scripts/state/job_state.py", "upsert-job", json.dumps(canonical)))
    return canonical


def can_apply(canonical: dict) -> tuple:
    proc = run_helper(py_helper("src/scripts/state/job_state.py", "can-apply", json.dumps(canonical)))
    if proc.returncode == 0:
        return True, ""
    if proc.returncode == 2:
        # The helper's refusal payload is JSON on stdout — reduce it to a
        # human-readable reason for the extension badge.
        try:
            refusal = json.loads(proc.stdout[proc.stdout.index("{"):])
            matched_in = refusal.get("matched_in", "history")
            matched_status = refusal.get("matched_status", "recorded")
            return False, f"already recorded — {matched_in} has status '{matched_status}'"
        except (ValueError, KeyError):
            return False, "already recorded — dedup refused the write"
    raise RuntimeError(f"can-apply failed (rc={proc.returncode}): {proc.stderr.strip()[-400:]}")


def append_entry(file_rel: str, entry: dict) -> str:
    """append via the dedup-guarded helper. Returns 'saved' or 'duplicate'."""
    proc = run_helper(py_helper("src/scripts/state/append_state_entry.py", file_rel, json.dumps(entry)))
    if proc.returncode == 0:
        return "saved"
    if proc.returncode == 2:
        return "duplicate"
    raise RuntimeError(f"append_state_entry failed (rc={proc.returncode}): {proc.stderr.strip()[-400:]}")


def record_event(canonical: dict, status: str, reasoning: str, url: str) -> None:
    helper_json(
        py_helper(
            "src/scripts/state/job_state.py",
            "record-event",
            json.dumps({
                "job_key": canonical["job_key"],
                "status": status,
                "reasoning": reasoning,
                "company": canonical.get("company"),
                "title": canonical.get("title"),
                "url": url,
            }),
        )
    )


def sheets_sync(canonical: dict, date_applied: str) -> str:
    """Best-effort tracker sync — mirrors the agent path. Never raises."""
    try:
        proc = run_helper(
            py_helper(
                "src/scripts/jobs/sync_internship_tracker.py",
                json.dumps({
                    "company": canonical.get("company"),
                    "title": canonical.get("title"),
                    "date_applied": date_applied,
                    "internship_term": canonical.get("internship_term") or "",
                }),
            )
        )
        if proc.returncode == 0:
            parsed = json.loads(proc.stdout or "{}")
            if parsed.get("synced"):
                return "synced"
            return f"skipped: {parsed.get('reason', 'sync disabled or unconfigured')}"
        return f"failed (rc={proc.returncode})"
    except Exception as exc:  # noqa: BLE001 — sync must never unwind a recorded outcome
        return f"failed: {exc}"


# ---------------------------------------------------------------------------
# Request handling


def handle_fit(payload: dict) -> dict:
    job = validate_job(payload)
    if not str(job.get("jd_text", "")).strip():
        # Same rule as the SimplifyJobs enrichment step: an empty JD would
        # bypass every deterministic hard-reject check in the fit gate.
        raise ValueError("job.jd_text is required — extract the posting description before the fit check")
    canonical = canonicalize_and_upsert(job)
    fit = helper_json(py_helper("src/scripts/jobs/evaluate_job_fit.py", json.dumps(canonical)))
    if fit.get("fit_status") not in {"candidate", "needs_review", "skipped_unfit"}:
        raise RuntimeError("fit helper returned an unexpected status")
    applyable, refusal = can_apply(canonical)
    return {
        "ok": True,
        "job_id": canonical["job_id"],
        "job_key": canonical["job_key"],
        "fit_status": fit["fit_status"],
        "fit_score": fit.get("fit_score"),
        "reasoning": fit.get("reasoning", ""),
        "can_apply": applyable,
        "can_apply_detail": refusal,
    }


def resolve_profile_url(usable: dict, kind: str) -> str:
    """Derive a full profile URL for the extension, whichever of
    `<kind>_username` / `<kind>_url` is actually populated — the extension
    pastes this verbatim into a field expecting a full URL, so it must
    never see a bare username."""
    username = usable.get(f"{kind}_username") or extract_username(kind, usable.get(f"{kind}_url", ""))
    return derive_full_url(kind, username)


def handle_fields(payload: dict) -> dict:
    keys = payload.get("keys")
    if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
        raise ValueError("body must include 'keys': [string, ...]")
    unknown = [k for k in keys if k not in SAFE_FIELD_KEYS]
    if unknown:
        raise ValueError(f"unknown safe_fields keys requested: {unknown}")
    usable = read_safe_fields()
    served = {}
    for k in keys:
        if k in ("linkedin_url", "github_url"):
            url = resolve_profile_url(usable, k.split("_")[0])
            if url:
                served[k] = url
        elif k in usable:
            served[k] = usable[k]
    log(f"served safe_fields keys: {sorted(served.keys())}")
    return {"ok": True, "fields": served}


def handle_outcome(payload: dict) -> dict:
    job = validate_job(payload)
    status = payload.get("status")
    if status not in ALLOWED_OUTCOMES:
        raise ValueError(f"status must be one of {sorted(ALLOWED_OUTCOMES)}")
    canonical = canonicalize_and_upsert(job)
    url = canonical.get("apply_url") or canonical["url"]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if status == "applied":
        applyable, refusal = can_apply(canonical)
        if not applyable:
            return {"ok": True, "recorded": False, "reason": refusal or "already recorded — dedup refused the write"}
        reasoning = "Applied manually via browser extension (hybrid mode)"
    else:
        reasoning = "Saved for review from browser extension (hybrid mode)"

    entry = {
        "job_id": canonical["job_id"],
        "company": canonical["company"],
        "title": canonical["title"],
        "url": url,
        "date_applied": today,
        "status": status,
        "role_type": role_type(canonical["title"]),
        "source": canonical["source"],
        "resume_used": "balanced",
        "ats_score": 0,
        "location_tier": location_tier(canonical.get("location", "")),
        "cover_letter_used": False,
        "reasoning": reasoning,
    }
    if append_entry("data/applied_jobs.json", entry) == "duplicate":
        return {"ok": True, "recorded": False, "reason": "already recorded — dedup refused the write"}
    if status == "needs_review":
        append_entry("data/review_queue.json", entry)
    record_event(canonical, status, reasoning, url)
    result = {"ok": True, "recorded": True, "job_id": canonical["job_id"], "status": status}
    if status == "applied":
        result["tracker_sync"] = sheets_sync(canonical, today)
    return result


ROUTES_POST = {"/fit": handle_fit, "/fields": handle_fields, "/outcome": handle_outcome}


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "aplyx-extension-bridge"
    token = ""  # set at startup

    def log_message(self, fmt, *args):  # route default logging through ours
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        expected = f"Bearer {self.token}"
        return bool(self.token) and hmac.compare_digest(header, expected)

    def do_GET(self):  # noqa: N802
        if not self._authorized():
            return self._send(401, {"ok": False, "error": "missing or invalid bridge token"})
        if self.path == "/health":
            return self._send(200, {"ok": True, "service": "aplyx-extension-bridge", "version": VERSION})
        if self.path == "/field-keys":
            return self._send(200, {"ok": True, "keys": sorted(read_safe_fields().keys())})
        return self._send(404, {"ok": False, "error": "unknown endpoint"})

    def do_POST(self):  # noqa: N802
        if not self._authorized():
            return self._send(401, {"ok": False, "error": "missing or invalid bridge token"})
        handler = ROUTES_POST.get(self.path)
        if handler is None:
            return self._send(404, {"ok": False, "error": "unknown endpoint"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._send(413, {"ok": False, "error": "body missing or too large"})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._send(400, {"ok": False, "error": "body is not valid JSON"})
        try:
            return self._send(200, handler(payload))
        except ValueError as exc:
            return self._send(400, {"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 — surfaced to the extension, never a stack dump
            log(f"ERROR on {self.path}: {exc}")
            return self._send(500, {"ok": False, "error": str(exc)})


def main() -> int:
    parser = argparse.ArgumentParser(description="aplyx browser-extension bridge (localhost only)")
    parser.add_argument("--port", type=int, help=f"override the configured port (default {DEFAULT_PORT})")
    parser.add_argument("--show-token", action="store_true", help="print the bridge token and exit")
    args = parser.parse_args()

    cfg = load_or_create_bridge_config()
    if args.show_token:
        print(cfg["token"])
        return 0

    port = args.port or int(cfg.get("port", DEFAULT_PORT))
    BridgeHandler.token = cfg["token"]

    # Ensure the state files the helpers append to exist before serving.
    for ensure in (
        py_helper("src/scripts/state/job_state.py", "ensure-files"),
        py_helper("src/scripts/state/append_state_entry.py", "ensure", "data/applied_jobs.json"),
        py_helper("src/scripts/state/append_state_entry.py", "ensure", "data/review_queue.json"),
    ):
        proc = run_helper(ensure)
        if proc.returncode != 0:
            log(f"ABORT: {' '.join(ensure)} failed: {proc.stderr.strip()[-300:]}")
            return 1

    server = ThreadingHTTPServer(("127.0.0.1", port), BridgeHandler)
    log(f"listening on http://127.0.0.1:{port} (token in {BRIDGE_CONFIG})")
    log("paste the token into the extension's options page (aplyx → Options)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
