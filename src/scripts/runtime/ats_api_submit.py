#!/usr/bin/env python3
"""ats_api_submit.py: official-API application submission.

The primary submit path for the ATS families that expose one:

  - Lever   — `POST https://api.lever.co/v0/postings/{site}/{id}`, the
              same endpoint Lever's own public apply form posts to. No
              API key. Fully supported here.
  - Greenhouse — `POST https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}`,
              the documented Job Board API. Needs the employer's Job
              Board API key (env `APLYX_GREENHOUSE_BOARD_KEY` or the
              `greenhouse_board_keys` map in src/config/targets.json).
              When no key is available this reports "fallback".
  - Ashby   — no keyless application API exists (submission lives behind
              the employer's authenticated API). Always "fallback".

`approve_submit_lever.py` / `approve_submit_greenhouse.py` call
`try_api_submit()` first and fall back to their existing Playwright
replay flow on anything other than a clean "submitted". Nothing here is
lost by turning the API path off (`APLYX_ATS_API_SUBMIT=0`).

Pure `urllib` (stdlib) — no browser, no local Chrome profile, no new
dependency — so the hosted auto-apply worker (docs/hosted-auto-apply-plan.md)
can call `try_api_submit()` or the `--stdin` CLI with the same fill
record + résumé path the local runtime uses.

Red line, unchanged from the Playwright runtimes: this never attempts to
satisfy a CAPTCHA / anti-bot challenge. If an endpoint demands one, the
result is "fallback" (browser or human review handles it), never a
programmatic bypass.
"""

from __future__ import annotations

import io
import json
import mimetypes
import os
import re
import sys
import uuid
from typing import Any, Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

LEVER_APPLY_HOSTS = {"jobs.lever.co", "api.lever.co"}
GREENHOUSE_HOSTS = {
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
    "boards-api.greenhouse.io",
}

_DEFAULT_TIMEOUT = 25


# --------------------------------------------------------------------------
# URL parsing
# --------------------------------------------------------------------------
def parse_lever_posting(url: str) -> Optional[tuple[str, str]]:
    """`(site, posting_id)` from a Lever apply/posting URL, or None.

    Handles jobs.lever.co/<site>/<uuid>[/apply][/thanks] and
    api.lever.co/v0/postings/<site>/<uuid>.
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    parts = [p for p in parsed.path.split("/") if p]
    if host == "jobs.lever.co" and len(parts) >= 2:
        site, posting_id = parts[0], parts[1]
    elif host == "api.lever.co" and parts[:2] == ["v0", "postings"] and len(parts) >= 4:
        site, posting_id = parts[2], parts[3]
    else:
        return None
    if _looks_like_uuid(posting_id):
        return site, posting_id
    return None


def parse_greenhouse_posting(url: str) -> Optional[tuple[str, str]]:
    """`(board_token, job_id)` from a Greenhouse apply/embed URL, or None."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if host not in GREENHOUSE_HOSTS and not host.endswith(".greenhouse.io"):
        return None
    query = dict(_parse_qsl(parsed.query))
    # /embed/job_app?for=<token>&token=<job_id>
    if "for" in query and query.get("token", "").isdigit():
        return query["for"], query["token"]
    parts = [p for p in parsed.path.split("/") if p]
    # boards-api…/v1/boards/<token>/jobs/<id>
    if parts[:2] == ["v1", "boards"] and "jobs" in parts:
        j = parts.index("jobs")
        if j >= 3 and j + 1 < len(parts) and parts[j + 1].isdigit():
            return parts[2], parts[j + 1]
    # boards.greenhouse.io/<token>/jobs/<id>
    if len(parts) >= 3 and parts[1] == "jobs" and parts[2].isdigit():
        return parts[0], parts[2]
    return None


def _parse_qsl(query: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for pair in query.split("&"):
        if not pair:
            continue
        k, _, v = pair.partition("=")
        out.append((k, v))
    return out


def _looks_like_uuid(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F-]{16,64}", value or "")) and "-" in value


# --------------------------------------------------------------------------
# Fill record -> normalized applicant fields
# --------------------------------------------------------------------------
_SAFE_KEY_ALIASES = {
    "linkedin_username": "linkedin",
    "linkedin_url": "linkedin",
    "github_username": "github",
    "github_url": "github",
}


class ApplicantFields:
    """Normalized view of a fill record: the mapped safe_fields, the
    résumé path, and any custom (label, value) answers the run made."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.resume_path: Optional[str] = None
        self.cover_letter: Optional[str] = None
        self.custom: list[tuple[str, str]] = []

    @property
    def full_name(self) -> str:
        if self.values.get("full_name"):
            return self.values["full_name"].strip()
        first = self.values.get("first_name", "").strip()
        last = self.values.get("last_name", "").strip()
        return " ".join(p for p in (first, last) if p)

    def link(self, kind: str) -> str:
        raw = self.values.get(kind, "").strip()
        if not raw:
            return ""
        if raw.startswith("http://") or raw.startswith("https://"):
            return raw
        if kind == "linkedin":
            return f"https://www.linkedin.com/in/{raw.lstrip('/')}"
        if kind == "github":
            return f"https://github.com/{raw.lstrip('/')}"
        return raw


def normalize_fields(fields: list[dict], resume_path: Optional[str]) -> ApplicantFields:
    out = ApplicantFields()
    out.resume_path = resume_path
    for entry in fields or []:
        source = str(entry.get("source", ""))
        value = str(entry.get("filled_value", ""))
        label = str(entry.get("field_name", "")).strip()
        if source == "resume_upload":
            # filled_value is a bare filename; the caller resolves the real
            # path and passes it as resume_path. Keep the filename only as a
            # last-resort hint.
            if not out.resume_path:
                out.resume_path = value or None
            continue
        if source == "cover_letter":
            out.cover_letter = value
            continue
        if source.startswith("safe_fields:"):
            key = source.split(":", 1)[1]
            key = _SAFE_KEY_ALIASES.get(key, key)
            out.values[key] = value
            continue
        if source in ("conservative_default", "constructed"):
            if label and value:
                out.custom.append((label, value))
    return out


# --------------------------------------------------------------------------
# multipart/form-data (stdlib has no encoder)
# --------------------------------------------------------------------------
def _encode_multipart(
    fields: list[tuple[str, str]],
    files: list[tuple[str, str, bytes]],
) -> tuple[bytes, str]:
    boundary = f"----aplyx{uuid.uuid4().hex}"
    buf = io.BytesIO()

    def w(s: str) -> None:
        buf.write(s.encode("utf-8"))

    for name, value in fields:
        w(f"--{boundary}\r\n")
        w(f'Content-Disposition: form-data; name="{name}"\r\n\r\n')
        w(value)
        w("\r\n")
    for name, filename, data in files:
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        w(f"--{boundary}\r\n")
        w(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n')
        w(f"Content-Type: {ctype}\r\n\r\n")
        buf.write(data)
        w("\r\n")
    w(f"--{boundary}--\r\n")
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


def _http(method: str, url: str, *, headers=None, body=None, content_type=None, timeout=_DEFAULT_TIMEOUT):
    """Returns (status, body_text). Never raises for an HTTP error status;
    a transport error (DNS, timeout, refused) returns (None, reason)."""
    req_headers = {"User-Agent": "aplyx/1.0 (+https://aplyx.app)", "Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    if content_type:
        req_headers["Content-Type"] = content_type
    req = Request(url, data=body, headers=req_headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace") if exc.fp else ""
    except (URLError, TimeoutError, OSError) as exc:
        return None, str(exc)


# --------------------------------------------------------------------------
# Lever
# --------------------------------------------------------------------------
def submit_lever(site: str, posting_id: str, fm: ApplicantFields, *, timeout=_DEFAULT_TIMEOUT) -> dict:
    if fm.custom:
        # Lever's custom "cards" questions are keyed by IDs that only exist
        # in the live apply form, not the public postings API. Mapping a
        # free-text label to the wrong card would submit a wrong answer to
        # a real employer, so defer to the browser replay instead.
        labels = ", ".join(lbl for lbl, _ in fm.custom[:3])
        return _fallback(f"Lever posting has custom questions ({labels}…); the browser replay handles those")
    if not fm.values.get("email") or not fm.full_name:
        return _fallback("missing name or email in the fill record")
    if not fm.resume_path or not os.path.isfile(fm.resume_path):
        return _fallback("résumé file not found for the API upload")

    form: list[tuple[str, str]] = [
        ("name", fm.full_name),
        ("email", fm.values["email"]),
    ]
    if fm.values.get("phone"):
        form.append(("phone", fm.values["phone"]))
    if fm.link("linkedin"):
        form.append(("urls[LinkedIn]", fm.link("linkedin")))
    if fm.link("github"):
        form.append(("urls[GitHub]", fm.link("github")))
    if fm.cover_letter:
        form.append(("comments", fm.cover_letter))
    # Attribution — Lever surfaces this to the employer as the application
    # source; being honest about it is the trust-first stance, not a place
    # to impersonate an organic applicant.
    form.append(("source", "aplyx"))
    form.append(("origin", "applied"))

    with open(fm.resume_path, "rb") as fh:
        resume_bytes = fh.read()
    body, ctype = _encode_multipart(form, [("resume", os.path.basename(fm.resume_path), resume_bytes)])

    url = f"https://api.lever.co/v0/postings/{site}/{posting_id}"
    status, text = _http("POST", url, body=body, content_type=ctype, timeout=timeout)

    if status is None:
        return _fallback(f"Lever API unreachable: {text}")
    if _challenge_in_response(status, text):
        return _fallback("Lever API returned an anti-bot challenge")
    if status in (200, 201):
        data = _json_or_none(text)
        if isinstance(data, dict) and (data.get("ok") is True or data.get("applicationId") or data.get("id")):
            app_id = data.get("applicationId") or data.get("id") or ""
            return _submitted(f"Lever accepted the application via the API{f' (id {app_id})' if app_id else ''}", {"application_id": app_id})
        # A 200 with no recognizable success payload is ambiguous — don't
        # log it as applied; let the browser path confirm.
        return _fallback(f"Lever API returned {status} but no application id; verifying via the browser")
    if status == 404:
        return _fallback("Lever posting not found via the API (likely closed); browser path will confirm")
    if status in (400, 422):
        return _fallback(f"Lever API rejected the submission ({status}): {_short(text)}")
    return _fallback(f"Lever API returned {status}")


# --------------------------------------------------------------------------
# Greenhouse
# --------------------------------------------------------------------------
def _greenhouse_board_key(board_token: str) -> Optional[str]:
    env = os.environ.get("APLYX_GREENHOUSE_BOARD_KEY", "").strip()
    if env:
        return env
    root = _project_root()
    if not root:
        return None
    cfg_path = os.path.join(root, "src", "config", "targets.json")
    try:
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    keys = cfg.get("greenhouse_board_keys")
    if isinstance(keys, dict):
        val = keys.get(board_token) or keys.get("*")
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def submit_greenhouse(board_token: str, job_id: str, fm: ApplicantFields, *, timeout=_DEFAULT_TIMEOUT) -> dict:
    key = _greenhouse_board_key(board_token)
    if not key:
        return _fallback(
            "Greenhouse submission needs the employer's Job Board API key "
            f"(set APLYX_GREENHOUSE_BOARD_KEY or greenhouse_board_keys[{board_token!r}] in targets.json); "
            "using the browser instead"
        )

    # Public: the posting's question set (field param names + required-ness).
    q_url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true"
    status, text = _http("GET", q_url, timeout=timeout)
    if status != 200:
        return _fallback(f"could not read the Greenhouse question set ({status})")
    job = _json_or_none(text) or {}
    questions = job.get("questions") or []

    form, unmatched = _map_greenhouse_questions(questions, fm)
    if unmatched:
        return _fallback(f"unmapped required Greenhouse field(s): {', '.join(unmatched[:4])}")

    files: list[tuple[str, str, bytes]] = []
    if fm.resume_path and os.path.isfile(fm.resume_path):
        with open(fm.resume_path, "rb") as fh:
            files.append(("resume", os.path.basename(fm.resume_path), fh.read()))

    body, ctype = _encode_multipart(form, files)
    import base64

    auth = base64.b64encode(f"{key}:".encode("utf-8")).decode("ascii")
    submit_url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}"
    status, text = _http(
        "POST", submit_url,
        headers={"Authorization": f"Basic {auth}"},
        body=body, content_type=ctype, timeout=timeout,
    )
    if status is None:
        return _fallback(f"Greenhouse API unreachable: {text}")
    if _challenge_in_response(status, text):
        return _fallback("Greenhouse API returned an anti-bot challenge")
    if status in (200, 201):
        data = _json_or_none(text)
        if isinstance(data, dict) and (data.get("success") or data.get("id")):
            return _submitted("Greenhouse accepted the application via the API", {"application_id": data.get("id", "")})
        return _fallback(f"Greenhouse API returned {status} with no success payload; verifying via the browser")
    if status in (401, 403):
        return _fallback(f"Greenhouse API rejected the key ({status}); using the browser")
    if status in (400, 422):
        return _fallback(f"Greenhouse API rejected the submission ({status}): {_short(text)}")
    return _fallback(f"Greenhouse API returned {status}")


_GH_CANONICAL = {
    "first_name": ("first_name",),
    "last_name": ("last_name",),
    "email": ("email",),
    "phone": ("phone",),
    "resume": ("resume",),
}


def _map_greenhouse_questions(questions: list, fm: ApplicantFields) -> tuple[list[tuple[str, str]], list[str]]:
    form: list[tuple[str, str]] = []
    unmatched: list[str] = []
    used_custom: set[int] = set()
    for q in questions:
        label = str(q.get("label", "")).strip()
        required = bool(q.get("required"))
        fields = q.get("fields") or []
        matched_any = False
        for field in fields:
            pname = str(field.get("name", ""))
            ftype = str(field.get("type", ""))
            if ftype == "attachment":
                matched_any = fm.resume_path is not None  # sent as the file part
                continue
            canon = _canonical_greenhouse_name(pname)
            if canon and fm.values.get(canon):
                form.append((pname, fm.values[canon]))
                matched_any = True
                continue
            if canon == "full_name" and fm.full_name:
                form.append((pname, fm.full_name))
                matched_any = True
                continue
            # custom question: match by label against the run's own answers
            for idx, (clabel, cvalue) in enumerate(fm.custom):
                if idx in used_custom:
                    continue
                if _label_match(label, clabel):
                    resolved = _resolve_select(field, cvalue)
                    if resolved is not None:
                        form.append((pname, resolved))
                        used_custom.add(idx)
                        matched_any = True
                    break
        if required and not matched_any:
            unmatched.append(label or "(unlabeled)")
    return form, unmatched


def _canonical_greenhouse_name(pname: str) -> Optional[str]:
    low = pname.lower()
    if low in ("first_name", "job_application[first_name]"):
        return "first_name"
    if low in ("last_name", "job_application[last_name]"):
        return "last_name"
    if "email" in low:
        return "email"
    if "phone" in low:
        return "phone"
    if low in ("name", "job_application[name]", "full_name"):
        return "full_name"
    return None


def _resolve_select(field: dict, value: str) -> Optional[str]:
    """For a select field, translate the run's human answer to the option
    value Greenhouse expects; return None when it can't be resolved (so the
    caller falls back rather than posting a bad option id)."""
    values = field.get("values")
    if not values:
        return value
    want = _norm(value)
    for opt in values:
        if _norm(str(opt.get("label", ""))) == want:
            return str(opt.get("value"))
    # yes/no phrasing
    if want in ("yes", "y", "true"):
        for opt in values:
            if _norm(str(opt.get("label", ""))) in ("yes", "true"):
                return str(opt.get("value"))
    if want in ("no", "n", "false"):
        for opt in values:
            if _norm(str(opt.get("label", ""))) in ("no", "false"):
                return str(opt.get("value"))
    return None


# --------------------------------------------------------------------------
# Dispatcher
# --------------------------------------------------------------------------
def try_api_submit(
    family: str,
    apply_url: str,
    fields: list[dict],
    resume_path: Optional[str],
    *,
    enabled: Optional[bool] = None,
    timeout: int = _DEFAULT_TIMEOUT,
) -> dict:
    """Attempt an official-API submission.

    Returns one of:
      {"status": "submitted", "message": ..., "extra": {...}}
      {"status": "fallback",  "reason": ...}   -> caller should use the browser
      {"status": "skipped",   "reason": ...}   -> API path disabled
    """
    if enabled is None:
        enabled = os.environ.get("APLYX_ATS_API_SUBMIT", "1").strip().lower() not in ("0", "false", "no", "off")
    if not enabled:
        return {"status": "skipped", "reason": "APLYX_ATS_API_SUBMIT is off"}

    fam = (family or "").lower()
    fm = normalize_fields(fields, resume_path)

    try:
        if fam == "lever":
            parsed = parse_lever_posting(apply_url)
            if not parsed:
                return _fallback("could not parse a Lever site/posting id from the apply URL")
            return submit_lever(*parsed, fm, timeout=timeout)
        if fam == "greenhouse":
            parsed = parse_greenhouse_posting(apply_url)
            if not parsed:
                return _fallback("could not parse a Greenhouse board/job id from the apply URL")
            return submit_greenhouse(*parsed, fm, timeout=timeout)
        if fam in ("ashbyhq", "ashby"):
            return _fallback("Ashby has no keyless application API; submission goes through the browser")
        return _fallback(f"no API submit path for family {fam!r}")
    except Exception as exc:  # never let an API bug block the browser fallback
        return _fallback(f"API submit raised {type(exc).__name__}: {exc}")


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def _submitted(message: str, extra: Optional[dict] = None) -> dict:
    return {"status": "submitted", "message": message, "extra": extra or {}}


def _fallback(reason: str) -> dict:
    return {"status": "fallback", "reason": reason}


def _json_or_none(text: str) -> Any:
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _short(text: str, limit: int = 200) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:limit]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _label_match(a: str, b: str) -> bool:
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return False
    return na == nb or na in nb or nb in na


def _challenge_in_response(status: Optional[int], text: str) -> bool:
    if status in (429, 503):
        return True
    low = (text or "").lower()
    return any(m in low for m in ("recaptcha", "captcha", "cf-challenge", "verify you are human", "turnstile"))


def _project_root() -> Optional[str]:
    here = os.path.abspath(os.path.dirname(__file__))
    cur = here
    for _ in range(8):
        if os.path.isfile(os.path.join(cur, "AGENTS.md")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return os.environ.get("APLYX_ROOT") or None


# --------------------------------------------------------------------------
# CLI — for the hosted worker (or a manual test): reads the same inputs the
# local runtime already has, prints the result dict as JSON.
# --------------------------------------------------------------------------
def main(argv=None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="ats_api_submit.py", description=__doc__)
    parser.add_argument("--family", required=True, choices=["lever", "greenhouse", "ashby", "ashbyhq"])
    parser.add_argument("--apply-url", required=True)
    parser.add_argument("--resume", default=None, help="path to the résumé file to upload")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--fields-json", help='JSON array of {"field_name","filled_value","source","verified"}')
    src.add_argument("--fields-file", help="path to a JSON file with that array")
    src.add_argument("--stdin", action="store_true", help="read the fields JSON array from stdin")
    parser.add_argument("--timeout", type=int, default=_DEFAULT_TIMEOUT)
    args = parser.parse_args(argv)

    if args.stdin:
        raw = sys.stdin.read()
    elif args.fields_file:
        with open(args.fields_file, "r", encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = args.fields_json
    try:
        parsed = json.loads(raw)
        # Accept either a bare array or a persisted fill record
        # ({"job_id":..., "fields":[...]}, the shape record_fill.py writes).
        fields = parsed["fields"] if isinstance(parsed, dict) and "fields" in parsed else parsed
        assert isinstance(fields, list)
    except (json.JSONDecodeError, AssertionError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "error", "reason": f"invalid fields JSON: {exc}"}))
        return 2

    result = try_api_submit(args.family, args.apply_url, fields, args.resume, timeout=args.timeout)
    print(json.dumps(result))
    return 0 if result.get("status") == "submitted" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"status": "error", "reason": f"unexpected error: {exc}"}))
        sys.exit(2)
