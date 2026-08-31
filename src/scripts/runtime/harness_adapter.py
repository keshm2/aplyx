#!/usr/bin/env python3
"""The single place that knows how each coding agent is invoked.

AGENTS.md "Harness capability matrix": *"the only harness-specific code is
the adapter block in src/scripts/runtime/run_job_agent.sh (never add harness
branches anywhere else)"*. That rule was easy to honor while `run_job_agent`
was the only thing that launched an agent. Interest-letter generation
(work item #4) needs to launch one too, so rather than grow a second copy of
the argv shapes, the adapter moved here and both callers import it. This
module IS that adapter block: the rule now reads "the only harness-specific
code lives in harness_adapter.py".

Two capability facts drive everything below (see the matrix in AGENTS.md):

  - opencode and Claude Code have a **subagent registry**, so an agent is
    named directly (`--agent <name>` / a generated `.claude/agents/` def)
    and delegation (`@resume-tailor` etc.) resolves against it natively,
    no extra instructions needed.
  - Copilot CLI gained a real custom-agent registry too (`.github/agents/`,
    `copilot --agent <name>`), detected here via a `--help` probe so an
    older Copilot CLI without it still gets the inline fallback rather than
    a silently-ignored flag. Codex CLI's `.codex/agents/*.toml` files are
    generated (forward-compat) but NOT wired in here: `codex exec` has no
    way to spawn a named subagent from them as of this writing
    (openai/codex#15250): the community-documented workaround is exactly
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

# PATH probe order. src/tui/src/harness.ts mirrors this for the Settings
# "Auto (detected and using X)" label; keep the two in sync or the UI will
# name a different agent than the one that actually runs.
DETECT_ORDER = SUPPORTED

# Harnesses with a subagent registry; everything else takes the inline path.
# Codex is deliberately absent: see the module docstring; copilot is
# checked at runtime (_copilot_has_agent_flag) since only newer CLI builds
# support it.
_HAS_REGISTRY = ("opencode", "claude")


def _well_known_bin_dirs() -> list:
    """Install locations the various harnesses/toolchains actually use,
    beyond plain PATH lookup. A Finder/Dock-launched desktop app inherits
    launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the
    user's shell profile PATH, so plain PATH lookup misses most real
    installs.

    Same fix as src/core/src/harness.ts's extraSearchDirs() (detecting an
    installed harness for the desktop Settings "Auto" label) and lib.rs's
    node_binary() (same thing for node). Shared directory list for
    _well_known_harness_dirs and harness_env() below."""
    home = os.path.expanduser("~")
    dirs = [
        os.path.join(home, ".local", "bin"),
        os.path.join(home, "bin"),
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".claude", "local"),  # Claude Code native installer wrapper
        os.path.join(home, ".opencode", "bin"),  # opencode standalone installer
        os.path.join(home, ".volta", "bin"),
        os.path.join(home, ".cargo", "bin"),
        os.path.join(home, ".npm-global", "bin"),
        os.path.join(home, "Library", "pnpm"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
    ]
    nvm_versions = os.path.join(home, ".nvm", "versions", "node")
    try:
        for entry in os.listdir(nvm_versions):
            dirs.append(os.path.join(nvm_versions, entry, "bin"))
    except OSError:
        pass  # no nvm, fine
    return dirs


def _well_known_harness_dirs(harness: str) -> list:
    """Same directories as _well_known_bin_dirs, with the harness binary
    name joined on. This is the search list resolve_harness_exe() probes
    below.

    Real bug this fixed: an opencode install at ~/.opencode/bin/opencode
    (opencode's actual default) worked fine from the TUI/terminal but
    threw FileNotFoundError from the desktop app's "Run now" button,
    because shutil.which("opencode") only sees this process's own
    inherited PATH."""
    return [os.path.join(d, harness) for d in _well_known_bin_dirs()]


def harness_env() -> dict:
    """Same environment this process already has, but with the well-known
    directories prepended to PATH: for the harness subprocess itself,
    not just for finding its executable (resolve_harness_exe handles
    that part). This is about what the harness can find once it's
    already running.

    Turns out fixing the binary lookup wasn't enough on its own. opencode
    started fine under the desktop app's "Run now" (GUI-launched, so a
    bare launchd PATH), but its Playwright MCP server never came up.
    opencode brings that up by running `npx @playwright/mcp@latest`, and
    npx/node live under Homebrew or nvm, nowhere near launchd's minimal
    PATH. opencode didn't surface an error for this either. The model
    just never saw a Playwright tool in its list and, correctly given
    what it could see, reported no browser automation and sent every
    apply to needs_review. A harness launched from an actual terminal
    (TUI, scheduler.sh under a login shell) already has a full PATH, so
    none of this applies there."""
    env = dict(os.environ)
    existing = env.get("PATH", "").split(os.pathsep)
    extra = [d for d in _well_known_bin_dirs() if os.path.isdir(d) and d not in existing]
    env["PATH"] = os.pathsep.join(extra + existing)
    return env


def resolve_harness_exe(harness: str) -> str:
    """The actual executable path for an already-resolved harness name
    (resolve_harness()'s return value): PATH lookup first (the common
    terminal/TUI case), then the well-known install locations above.
    Falls back to the bare name so a real PATH-based install keeps
    working exactly as before and a genuinely-missing harness still fails
    with a clear "no such file" rather than something more confusing."""
    found = shutil.which(harness)
    if found:
        return found
    for candidate in _well_known_harness_dirs(harness):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return harness


def _copilot_has_agent_flag(exe: str) -> bool:
    """Probes for --agent support (Copilot CLI's custom-agent registry
    flag) the same way opencode_print_flag probes for --print, an older
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
    """Env override, then src/config/harness.json, then a PATH probe. Returns ""
    when nothing usable is found (callers report their own error)."""
    harness = os.environ.get("APLYX_HARNESS", os.environ.get("FLUX_HARNESS", os.environ.get("ARES_HARNESS", ""))) or ""
    if not harness:
        cfg = os.path.join(root, "src", "config", "harness.json")
        if os.path.isfile(cfg):
            try:
                with open(cfg, "r", encoding="utf-8") as fh:
                    harness = json.load(fh).get("harness") or ""
            except (OSError, json.JSONDecodeError):
                harness = ""
    if not harness:
        for candidate in DETECT_ORDER:
            if shutil.which(candidate) or resolve_harness_exe(candidate) != candidate:
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
        f"You are the {agent} {role}. Read src/agents/bodies/{agent}.md and execute it "
        "exactly as your instructions."
    )
    if delegates:
        joined = " or ".join(f"@{d}" for d in delegates)
        files = " or ".join(f"src/agents/bodies/{d}.md" for d in delegates)
        text += (
            f" Your harness has no subagent registry: when the workflow delegates to {joined}, "
            f"read {files} and perform that role inline, following it exactly."
        )
    return text


def agent_command(exe: str, harness: str, agent: str, prompt: str,
                  delegates: tuple = (), extra_preamble: str = "",
                  role: str = "agent", standalone: bool = False) -> list:
    """Build the argv that runs `agent` under `harness` with `prompt`.

    `delegates` / `extra_preamble` only affect harnesses without a registry:
    a registry harness gets the agent by name and its generated definition
    already carries the body.

    `standalone`: True when this call IS the entire harness session (a
    one-shot subagent invocation, e.g. a preview tool), rather than
    `agent` being reached via in-session delegation from an
    already-running orchestrator (the normal job-scraper -> @resume-tailor
    path). Every generated agent definition except job-scraper itself is
    `mode: subagent` in its opencode frontmatter, reachable via opencode's
    own in-session delegation, but NOT via `opencode run --agent <name>`
    at the top level: confirmed empirically (2026-08-19) that opencode
    silently falls back to the project's default agent (job-scraper)
    instead of erroring, which would run the wrong agent entirely with no
    indication anything went wrong. `standalone=True` forces the same
    inline-body path already used for no-registry harnesses (Codex,
    older Copilot) even on opencode, sidestepping the subagent-mode
    restriction the same way Claude Code's headless `-p` entry point
    already has to (see that branch below; it never uses a registry
    selector regardless of `standalone`, for the same underlying reason).
    Copilot's own agent defs declare `user-invocable: true` and its CLI
    has no equivalent subagent-mode restriction, so its branch is
    unaffected by this flag.
    """
    if harness == "opencode" and not standalone:
        return [exe, "run", "--agent", agent, *opencode_print_flag(exe), prompt]
    if harness == "claude":
        perm = os.environ.get("APLYX_CLAUDE_PERMISSION_MODE", os.environ.get("FLUX_CLAUDE_PERMISSION_MODE", "bypassPermissions"))
        # Claude Code resolves .claude/agents/ defs, but the headless -p entry
        # point doesn't auto-select one, so the body is named explicitly. No
        # delegate inlining here. The registry handles it.
        return [exe, "-p", "--permission-mode", perm,
                inline_preamble(agent, (), role) + " " + prompt]
    if harness == "copilot" and _copilot_has_agent_flag(exe):
        # .github/agents/<name>.md exists (generate_agent_definitions.py) and
        # this CLI build recognizes --agent, so delegation resolves against
        # the registry the same way it does for opencode/Claude, no
        # delegate inlining needed. Still names the top-level agent
        # explicitly, matching Claude's pattern above: nothing here assumes
        # --agent alone selects the right one without also saying so in the
        # prompt.
        full = inline_preamble(agent, (), role)
        if extra_preamble:
            full += " " + extra_preamble
        full += " " + prompt
        return [exe, "--agent", agent, "--prompt", full, "--allow-all-tools"]
    # codex, copilot without --agent support, and opencode when standalone=True
    # (see the standalone= docstring above), no usable top-level registry
    # selector for this call, inline the body.
    full = inline_preamble(agent, delegates, role)
    if extra_preamble:
        full += " " + extra_preamble
    full += " " + prompt
    if harness == "codex":
        return [exe, "exec", full]
    if harness == "opencode":
        return [exe, "run", *opencode_print_flag(exe), full]
    return [exe, "-p", full, "--allow-all-tools"]


def has_registry(harness: str) -> bool:
    return harness in _HAS_REGISTRY
