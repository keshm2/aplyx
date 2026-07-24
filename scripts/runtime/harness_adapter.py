#!/usr/bin/env python3
"""The single place that knows how each coding agent is invoked.

AGENTS.md "Harness capability matrix": *"the only harness-specific code is
the adapter block in scripts/runtime/run_job_agent.sh (never add harness
branches anywhere else)"*. That rule was easy to honor while `run_job_agent`
was the only thing that launched an agent. Interest-letter generation
(work item #4) needs to launch one too, so rather than grow a second copy of
the argv shapes, the adapter moved here and both callers import it. This
module IS that adapter block — the rule now reads "the only harness-specific
code lives in harness_adapter.py".

Two capability facts drive everything below (see the matrix in AGENTS.md):

  - opencode and Claude Code have a **subagent registry**, so an agent is
    named directly (`--agent <name>` / a generated `.claude/agents/` def)
    and delegation (`@resume-tailor` etc.) resolves against it natively —
    no extra instructions needed.
  - Copilot CLI gained a real custom-agent registry too (`.github/agents/`,
    `copilot --agent <name>`) — detected here via a `--help` probe so an
    older Copilot CLI without it still gets the inline fallback rather than
    a silently-ignored flag. Codex CLI's `.codex/agents/*.toml` files are
    generated (forward-compat) but NOT wired in here: `codex exec` has no
    way to spawn a named subagent from them as of this writing
    (openai/codex#15250) — the community-documented workaround is exactly
    the inline fallback below, so that stays Codex's real path, not a
    stopgap.

Keeping both shapes here is what makes a new agent work on all four harnesses
by construction instead of by remembering to update four call sites.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess

SUPPORTED = ("opencode", "claude", "codex", "copilot")

# PATH probe order. app/src/harness.ts mirrors this for the Settings
# "Auto (detected and using X)" label — keep the two in sync or the UI will
# name a different agent than the one that actually runs.
DETECT_ORDER = SUPPORTED

# Harnesses with a subagent registry; everything else takes the inline path.
# Codex is deliberately absent — see the module docstring; copilot is
# checked at runtime (_copilot_has_agent_flag) since only newer CLI builds
# support it.
_HAS_REGISTRY = ("opencode", "claude")


def _copilot_has_agent_flag(exe: str) -> bool:
    """Probes for --agent support (Copilot CLI's custom-agent registry
    flag) the same way opencode_print_flag probes for --print — an older
    Copilot CLI without it must fall back to inlining the agent body
    rather than passing a flag it silently ignores."""
    try:
        help_txt = subprocess.run(
            [exe, "--help"], stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True,
        ).stdout or ""
        return bool(re.search(r"--agent([^-0-9A-Za-z]|$)", help_txt))
    except OSError:
        return False


def resolve_harness(root: str = ".") -> str:
    """Env override, then config/harness.json, then a PATH probe. Returns ""
    when nothing usable is found (callers report their own error)."""
    harness = os.environ.get("APLYX_HARNESS", os.environ.get("FLUX_HARNESS", os.environ.get("ARES_HARNESS", ""))) or ""
    if not harness:
        cfg = os.path.join(root, "config", "harness.json")
        if os.path.isfile(cfg):
            try:
                with open(cfg, "r", encoding="utf-8") as fh:
                    harness = json.load(fh).get("harness") or ""
            except (OSError, json.JSONDecodeError):
                harness = ""
    if not harness:
        for candidate in DETECT_ORDER:
            if shutil.which(candidate):
                harness = candidate
                break
    return harness if harness in SUPPORTED else ""


def opencode_print_flag(exe: str) -> list:
    """opencode >= 1.17 removed `--print`; probe rather than assume, so both
    the old and new CLI launch (regression from the 2026-07-12 fix)."""
    try:
        help_txt = subprocess.run(
            [exe, "run", "--help"], stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True,
        ).stdout or ""
        if re.search(r"--print([^-0-9A-Za-z]|$)", help_txt):
            return ["--print"]
    except OSError:
        pass
    return []


def inline_preamble(agent: str, delegates: tuple = (), role: str = "agent") -> str:
    """The no-registry fallback: tell the harness to read the agent body and
    act as it. `delegates` names any subagents that body hands off to, which
    must also be inlined (AGENTS.md "Degraded paths").

    `role` exists only to reproduce run_job_agent.py's original wording
    ("the job-scraper orchestrator") byte-for-byte, so extracting this block
    could not quietly change the prompt a live run sends.
    """
    text = (
        f"You are the {agent} {role}. Read agents/bodies/{agent}.md and execute it "
        "exactly as your instructions."
    )
    if delegates:
        joined = " or ".join(f"@{d}" for d in delegates)
        files = " or ".join(f"agents/bodies/{d}.md" for d in delegates)
        text += (
            f" Your harness has no subagent registry: when the workflow delegates to {joined}, "
            f"read {files} and perform that role inline, following it exactly."
        )
    return text


def agent_command(exe: str, harness: str, agent: str, prompt: str,
                  delegates: tuple = (), extra_preamble: str = "",
                  role: str = "agent") -> list:
    """Build the argv that runs `agent` under `harness` with `prompt`.

    `delegates` / `extra_preamble` only affect harnesses without a registry:
    a registry harness gets the agent by name and its generated definition
    already carries the body.
    """
    if harness == "opencode":
        return [exe, "run", "--agent", agent, *opencode_print_flag(exe), prompt]
    if harness == "claude":
        perm = os.environ.get("APLYX_CLAUDE_PERMISSION_MODE", os.environ.get("FLUX_CLAUDE_PERMISSION_MODE", "bypassPermissions"))
        # Claude Code resolves .claude/agents/ defs, but the headless -p entry
        # point doesn't auto-select one, so the body is named explicitly. No
        # delegate inlining here — the registry handles it.
        return [exe, "-p", "--permission-mode", perm,
                inline_preamble(agent, (), role) + " " + prompt]
    if harness == "copilot" and _copilot_has_agent_flag(exe):
        # .github/agents/<name>.md exists (generate_agent_definitions.py) and
        # this CLI build recognizes --agent, so delegation resolves against
        # the registry the same way it does for opencode/Claude — no
        # delegate inlining needed. Still names the top-level agent
        # explicitly, matching Claude's pattern above: nothing here assumes
        # --agent alone selects the right one without also saying so in the
        # prompt.
        full = inline_preamble(agent, (), role)
        if extra_preamble:
            full += " " + extra_preamble
        full += " " + prompt
        return [exe, "--agent", agent, "--prompt", full, "--allow-all-tools"]
    # codex, and copilot without --agent support — no usable registry,
    # inline the body.
    full = inline_preamble(agent, delegates, role)
    if extra_preamble:
        full += " " + extra_preamble
    full += " " + prompt
    if harness == "codex":
        return [exe, "exec", full]
    return [exe, "-p", full, "--allow-all-tools"]


def has_registry(harness: str) -> bool:
    return harness in _HAS_REGISTRY
