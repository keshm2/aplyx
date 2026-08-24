"""_jd_text.py — shared HTML-to-readable-text conversion for job descriptions.

Every fetch_*_listings.py script in this directory used to define its own
copy-pasted `strip_html()` (naive `re.sub(r"<[^>]+>", " ", markup)`) that
flattened an entire posting — headings, bullet lists, paragraph breaks,
everything — into one run-on line, and only ran `html.unescape()` once,
which leaves a double-encoded source (entities like "&amp;lt;" instead of
"&lt;") showing literal "&lt;p&gt;"-style text instead of real tags to
strip at all. Confirmed live as an actual bug, not a hypothetical: a real
Greenhouse `content` field double-encodes this way.

Mirrors src/core/src/jobs.ts's htmlToText()/markHeadings() (the TypeScript
fetchers' equivalent fix) so both language runtimes produce the same
shape of output: real paragraph breaks, "• " bullets instead of flattened
<li> text, and "### Heading" marker lines for detected section headings
that a UI can split on and render distinctly — the JobsScreen "why is
this all one wall of text" complaint this whole fix responds to.

Importable directly by any fetch_*_listings.py in this same directory —
Python puts a script's own directory at sys.path[0] automatically, so no
package/install step is needed for the sibling import to work.
"""

from __future__ import annotations

import html
import re

_HEADING_TAG_RE = re.compile(r"<h[1-6][^>]*>([\s\S]*?)</h[1-6]>", re.IGNORECASE)
_BOLD_PARAGRAPH_RE = re.compile(r"<p[^>]*>\s*<(?:strong|b)>([^<]{1,80})</(?:strong|b)>\s*</p>", re.IGNORECASE)
_BOLD_BEFORE_LIST_RE = re.compile(r"<(?:strong|b)>([^<]{1,80})</(?:strong|b)>\s*(?=<ul|<ol|<br)", re.IGNORECASE)
_LI_OPEN_RE = re.compile(r"<li[^>]*>", re.IGNORECASE)
_BLOCK_CLOSE_RE = re.compile(r"</(?:p|div|h[1-6]|tr)>", re.IGNORECASE)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_LIST_CLOSE_RE = re.compile(r"</(?:ul|ol)>", re.IGNORECASE)
_ANY_TAG_RE = re.compile(r"<[^>]+>")
_MULTI_BLANK_RE = re.compile(r"\n{3,}")
_INLINE_WS_RE = re.compile(r"[ \t]+")


def _decode_entities(text: str) -> str:
    """Repeated html.unescape() up to a fixed point (capped at 3 passes —
    real content never nests this deep; this is just a backstop against
    pathological input). A single unescape() call only reverses one layer
    of encoding, so a genuinely double-encoded source ("&amp;lt;p&amp;gt;")
    needs more than one pass to ever reveal real tags."""
    result = text
    for _ in range(3):
        nxt = html.unescape(result)
        if nxt == result:
            break
        result = nxt
    return result


def _mark_headings(markup: str) -> str:
    """Marks real section headings so downstream rendering can show them
    distinctly. Two patterns cover what postings actually use in practice:
    real <h1-6> tags, and a <p>/bare <strong> run whose entire short text
    IS the heading (e.g. Greenhouse's "<p><strong>Responsibilities</strong>
    </p>") — postings built with a plain rich-text editor rarely use real
    heading tags for this."""
    marked = _HEADING_TAG_RE.sub(lambda m: f"\n\n### {m.group(1)}\n", markup)
    marked = _BOLD_PARAGRAPH_RE.sub(lambda m: f"\n\n### {m.group(1)}\n", marked)
    marked = _BOLD_BEFORE_LIST_RE.sub(lambda m: f"\n\n### {m.group(1)}\n", marked)
    return marked


def html_to_text(markup: str) -> str:
    """Converts one HTML job-description fragment into readable plain
    text: real paragraph breaks, "### Heading" marker lines for detected
    section headings, "• " bullets instead of flattened <li> content, and
    fully entity-decoded (including double-encoded sources)."""
    if not isinstance(markup, str) or not markup:
        return ""
    decoded = _decode_entities(markup)
    with_headings = _mark_headings(decoded)
    with_breaks = _LI_OPEN_RE.sub("\n• ", with_headings)
    with_breaks = _BLOCK_CLOSE_RE.sub("\n\n", with_breaks)
    with_breaks = _BR_RE.sub("\n", with_breaks)
    with_breaks = _LIST_CLOSE_RE.sub("\n", with_breaks)
    stripped = _decode_entities(_ANY_TAG_RE.sub("", with_breaks))
    lines = []
    for line in stripped.split("\n"):
        if line.startswith("### "):
            lines.append(line.strip())
        else:
            lines.append(_INLINE_WS_RE.sub(" ", line).strip())
    joined = "\n".join(lines)
    return _MULTI_BLANK_RE.sub("\n\n", joined).strip()


def join_sections(sections: list[tuple[str | None, str]]) -> str:
    """Joins several known, separately-fetched fields (e.g. Amazon's
    description/basic_qualifications/preferred_qualifications, each its
    own API field with no heading markup of its own) into one jd_text,
    labeling each with a real "### Heading" marker line built from the
    field's own known purpose — more reliable than heuristically
    detecting a heading that was never there to begin with, since the API
    itself already told us what each part is. `sections` is a list of
    (label_or_None, raw_html_or_text) pairs; a None label means the part
    has no natural heading of its own (used sparingly — most callers of
    this function have real labels for every part, that's the point)."""
    parts: list[str] = []
    for label, raw in sections:
        text = html_to_text(raw)
        if not text:
            continue
        parts.append(f"### {label}\n\n{text}" if label else text)
    return "\n\n".join(parts)


# --- Pay extraction ----------------------------------------------------
#
# Only Ashby ships structured compensation data (min/max/currency/interval
# — see fetch handling in jobs.ts, which uses that directly rather than
# this regex path). Every other source only ever states pay as free text
# somewhere in the description ("$117,300.00 - $160,000.00 USD annually",
# "$45.00 - $65.00 USD hourly"), so this is a best-effort text-mining
# extractor, same honesty posture as the "N people applied" social-proof
# counter — a signal to show, not a guaranteed-accurate structured field.

_NUM = r"\d{1,3}(?:,\d{3})*(?:\.\d+)?K?"
_CURRENCY_CODE = r"USD|CAD|GBP|EUR|AUD"
# Two range shapes, tried in order: "$X - $Y" (dollar sign leads), and
# "X - Y USD" (bare numbers, currency code trails instead) — confirmed
# live as a real, common shape (Amazon's own postings: "117,300.00 -
# 160,000.00 USD annually", no $ anywhere). The trailing-currency-code
# requirement on the second shape is deliberate: bare numbers with a dash
# between them are everywhere in a job posting (dates, distances, version
# ranges) and would be far too risky to treat as pay without it.
# Global variants of the same two range shapes — extract_pay scans for
# EVERY match in the document, not just the first, since real multi-
# location postings (pay-transparency compliance boilerplate, confirmed
# live on Okta/Brex postings) state a genuinely different range per
# location, e.g. Okta: "...for candidates located in Canada is between:
# $116,000 — $159,500 CAD", stated as a second, separate range after the
# US one earlier in the same posting.
# A per-number interval tag ("/hr", "/yr", etc.) attached directly to
# EITHER side of the range — confirmed live as a real, common shape
# (Twilio: "$30.09/hr - $37.61/hr", the tag repeated on both numbers,
# not stated once after the range the way "$45 - $65 USD hourly" does).
# Captured (not just consumed) so it can decide the interval directly —
# more reliable than the forward/magnitude fallbacks below, and the only
# way to detect it at all here, since once consumed inside the match it's
# no longer sitting in the text *after* match.end() for _detect_interval
# to find.
_INLINE_INTERVAL_TAG = r"(?:/\s*(hr|hour|hourly|yr|year|annum))?"
_PAY_RANGE_DOLLAR_RE = re.compile(
    rf"\$\s?({_NUM}){_INLINE_INTERVAL_TAG}\s*(?:-|–|—|to)\s*\$?\s?({_NUM}){_INLINE_INTERVAL_TAG}", re.IGNORECASE
)
_PAY_RANGE_CODE_RE = re.compile(rf"({_NUM})\s*(?:-|–|—|to)\s*({_NUM})\s*(?:{_CURRENCY_CODE})\b", re.IGNORECASE)
_HOURLY_WORD_RE = re.compile(r"\b(hourly|hour|hr)\b|/\s*hr\b|per\s+hour", re.IGNORECASE)
_YEARLY_WORD_RE = re.compile(r"\b(yearly|annual(?:ly)?|year|yr)\b|/\s*yr\b|per\s+year", re.IGNORECASE)
_CONTEXT_WINDOW = 40
# Looks BACKWARD from a matched range for the location phrase real
# pay-transparency boilerplate states right before the number — "for
# candidates located in Canada is between:", "and for SLC it is"
# (Okta/Brex), "Based in Colorado... :" (Twilio, confirmed live — hence
# re.IGNORECASE here: a bullet-list item capitalizes "Based" at its own
# start, not just mid-sentence "based in"). Captures up to the first
# natural stop (comma, parenthesis, "is"/"are"/"it") so a long qualifier
# list ("California (excluding SF Bay Area), Colorado, ...") still yields
# one short, representative label rather than a whole sentence.
_LOCATION_LABEL_RE = re.compile(
    r"(?:located in|based in|for)\s+([A-Z][A-Za-z.]{1,20}(?:\s[A-Z][A-Za-z.]{1,20})?)(?=\s*[,(:]|\s+(?:is|are|it)\b)",
    re.IGNORECASE,
)
_LOCATION_LABEL_WINDOW = 250


def _parse_amount(raw: str) -> float:
    """'117,300.00' -> 117300.0, '257K' -> 257000.0."""
    cleaned = raw.replace(",", "")
    if cleaned.upper().endswith("K"):
        return float(cleaned[:-1]) * 1000
    return float(cleaned)


def _format_amount(value: float) -> str:
    if value >= 1000:
        return f"${round(value / 1000)}K"
    if value == int(value):
        return f"${int(value)}"
    return f"${value:.2f}"


def _detect_interval(text: str, end_pos: int) -> str | None:
    """Looks for an explicit 'hourly'/'annually'-type word shortly after
    the matched amount — the actual interval marker in real postings sits
    right next to the number ("... USD annually"), never far from it."""
    window = text[end_pos : end_pos + _CONTEXT_WINDOW]
    if _HOURLY_WORD_RE.search(window):
        return "hour"
    if _YEARLY_WORD_RE.search(window):
        return "year"
    return None


def _location_label(text: str, start_pos: int) -> str | None:
    """Best-effort location tag for one matched range — see
    _LOCATION_LABEL_RE's own comment. Only meaningful once a posting has
    already been confirmed to state more than one distinct range; a
    single-range posting never needs a label at all."""
    window = text[max(0, start_pos - _LOCATION_LABEL_WINDOW) : start_pos]
    # Scoped to the CURRENT bullet only, if inside one — confirmed live
    # as a real bug otherwise: a later bullet whose own location phrase
    # didn't match (e.g. multi-word names the regex still misses) fell
    # back to an EARLIER bullet's stale match still sitting in the window
    # (Twilio's 2nd range wrongly labeled "Colorado", the 1st bullet's
    # own location, instead of showing no label at all).
    last_bullet = window.rfind("•")
    if last_bullet != -1:
        window = window[last_bullet:]
    matches = _LOCATION_LABEL_RE.findall(window)
    return matches[-1].strip() if matches else None


def _tag_to_interval(tag: str | None) -> str | None:
    if not tag:
        return None
    return "hour" if tag.lower().startswith(("hr", "hour")) else "year"


def _find_all_ranges(text: str) -> list[tuple[int, int, float, float, str | None]]:
    """Every non-overlapping range match in the document, dollar-prefixed
    or currency-code-suffixed, as (start, end, low, high, inline_interval)
    — start/end of the OUTER match span, used both for interval detection
    (forward) and location-label detection (backward). inline_interval
    comes from a "/hr"-style tag attached directly to either number (see
    _INLINE_INTERVAL_TAG) when present — only _PAY_RANGE_DOLLAR_RE has
    this capability; _PAY_RANGE_CODE_RE's groups are just (low, high)."""
    spans: list[tuple[int, int, float, float, str | None]] = []
    for m in _PAY_RANGE_DOLLAR_RE.finditer(text):
        low, low_tag, high, high_tag = m.group(1), m.group(2), m.group(3), m.group(4)
        spans.append((m.start(), m.end(), _parse_amount(low), _parse_amount(high), _tag_to_interval(low_tag) or _tag_to_interval(high_tag)))
    for m in _PAY_RANGE_CODE_RE.finditer(text):
        spans.append((m.start(), m.end(), _parse_amount(m.group(1)), _parse_amount(m.group(2)), None))
    spans.sort(key=lambda s: s[0])
    return spans


def extract_pay(text: str) -> str | None:
    """Best-effort "$X–$Y/yr" or "$X–$Y/hr" pay line(s) mined from a
    posting's free text. Only ever matches a RANGE (two numbers with a
    dash) — deliberately never a single dollar amount. A lone number
    turned out live, twice, to latch onto real but unrelated dollar
    mentions with an interval word coincidentally nearby ("revenue
    targets >$1M per year" as a job requirement; "a $1,500 USD
    learning stipend... per year" as a benefit) — a plausibility floor on
    the number wasn't enough, since both looked like perfectly reasonable
    amounts on their own. Pay-transparency laws (CA/CO/NY/WA and others)
    have also made stating an actual range the norm for real compensation
    disclosure, while stipends/bonuses/targets are almost always single
    numbers — so restricting to ranges trades a modest amount of recall
    (postings that state one flat number) for meaningfully higher
    precision (never confidently mislabeling a stipend as a salary).

    Scans the WHOLE document for every distinct range, not just the
    first — confirmed live that real multi-location postings state a
    genuinely different range per location (Okta: separate US/Canada pay-
    range blocks; Brex: "...is $185,320 - $231,650 and for SLC it is
    $164,000 - $205,000" inline) — returning only the first would
    silently show one location's number as if it applied everywhere.
    When 2+ distinct ranges are found, each gets its own best-effort
    location label (see _location_label) and they're joined with " · ";
    a single-range posting gets no label at all, nothing to disambiguate
    from. When no explicit interval word is found for a given range,
    falls back to a magnitude heuristic: real hourly rates are
    essentially never >= $1000, real salaries essentially always are
    (this is what covers Ashby-style "$257K – $335K" compensation
    summaries that state a range with no interval word attached)."""
    if not text:
        return None
    spans = _find_all_ranges(text)
    if not spans:
        return None
    formatted: list[tuple[str, int]] = []
    seen: set[tuple[float, float]] = set()
    for start, end, low, high, inline_interval in spans:
        key = (low, high)
        if key in seen:
            continue
        seen.add(key)
        interval = inline_interval or _detect_interval(text, end)
        if interval is None:
            interval = "hour" if max(low, high) < 1000 else "year"
        suffix = "hr" if interval == "hour" else "yr"
        formatted.append((f"{_format_amount(low)}–{_format_amount(high)}/{suffix}", start))
    if len(formatted) == 1:
        return formatted[0][0]
    parts = []
    for value, start in formatted:
        label = _location_label(text, start)
        parts.append(f"{value} ({label})" if label else value)
    return " · ".join(parts)
