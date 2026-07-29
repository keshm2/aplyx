#!/usr/bin/env python3
"""generate_agent_definitions.py — harness agent generation (Phase 15/16).

Single source of truth for agent behavior:

  src/agents/bodies/<name>.md                 the prompt body (harness-neutral)
  src/agents/frontmatter/opencode/<name>.yaml  opencode frontmatter
  src/agents/frontmatter/claude/<name>.yaml    Claude Code frontmatter
  src/agents/frontmatter/copilot/<name>.yaml   Copilot CLI frontmatter
  src/agents/frontmatter/codex/<name>.toml     Codex CLI metadata (TOML, no body)

This script composes them into the per-harness definitions:

  .opencode/agents/<name>.md
  .claude/agents/<name>.md
  .github/agents/<name>.md    (Copilot CLI custom-agent convention)
  .codex/agents/<name>.toml   (Codex CLI subagent convention)

opencode/claude/copilot share one format: YAML frontmatter + the shared
body, exactly like before. Codex is different — its subagents are TOML
files with the body embedded as a `developer_instructions` field, not a
separate frontmatter+markdown split — so it gets its own compose
function. See AGENTS.md's harness capability matrix for why Codex's
generated file exists but isn't (yet) wired into harness_adapter.py's
actual invocation path: codex exec currently has no way to spawn a named
subagent from .codex/agents/ (openai/codex#15250) — the file is
forward-compatible prep, not a working registry today.

Never hand-edit the generated files — edit the sources and re-run. Each
generated file carries a GENERATED marker naming its sources. `--check`
regenerates in memory and exits 1 if any generated file is missing or
stale (for CI / pre-run drift detection).

Exit codes: 0 ok; 1 drift found (--check) or usage error.
"""

from __future__ import annotations

import argparse
import os
import sys

MD_HARNESSES = ("opencode", "claude", "copilot")
TOML_HARNESSES = ("codex",)
HARNESSES = MD_HARNESSES + TOML_HARNESSES

MD_MARKER = (
    "<!-- GENERATED from src/agents/bodies/{name}.md + "
    "src/agents/frontmatter/{harness}/{name}.yaml — edit those sources and run "
    "src/scripts/validate/generate_agent_definitions.py -->"
)

TOML_MARKER = (
    "# GENERATED from src/agents/bodies/{name}.md + "
    "src/agents/frontmatter/{harness}/{name}.toml — edit those sources and run "
    "src/scripts/validate/generate_agent_definitions.py"
)

OUT_DIRS = {
    "opencode": ".opencode/agents",
    "claude": ".claude/agents",
    "copilot": ".github/agents",
    "codex": ".codex/agents",
}

OUT_EXT = {"opencode": "md", "claude": "md", "copilot": "md", "codex": "toml"}
SRC_EXT = {"opencode": "yaml", "claude": "yaml", "copilot": "yaml", "codex": "toml"}


def compose_md(root: str, harness: str, name: str) -> str:
    body_path = os.path.join(root, "src", "agents", "bodies", f"{name}.md")
    fm_path = os.path.join(root, "src", "agents", "frontmatter", harness, f"{name}.yaml")
    with open(fm_path, "r", encoding="utf-8") as f:
        frontmatter = f.read().rstrip("\n")
    with open(body_path, "r", encoding="utf-8") as f:
        body = f.read().rstrip("\n")
    marker = MD_MARKER.format(name=name, harness=harness)
    return f"---\n{frontmatter}\n---\n{marker}\n\n{body}\n"


def compose_toml(root: str, harness: str, name: str) -> str:
    body_path = os.path.join(root, "src", "agents", "bodies", f"{name}.md")
    fm_path = os.path.join(root, "src", "agents", "frontmatter", harness, f"{name}.toml")
    with open(fm_path, "r", encoding="utf-8") as f:
        metadata = f.read().rstrip("\n")
    with open(body_path, "r", encoding="utf-8") as f:
        body = f.read().rstrip("\n")
    if "'''" in body:
        raise ValueError(
            f"src/agents/bodies/{name}.md contains a literal ''' sequence, which "
            "breaks TOML's ''' multi-line literal string — rewrite the body "
            "to avoid it before generating."
        )
    marker = TOML_MARKER.format(name=name, harness=harness)
    return f"{marker}\n\n{metadata}\ndeveloper_instructions = '''\n{body}\n'''\n"


def source_path(root: str, harness: str, name: str) -> str:
    return os.path.join(root, "src", "agents", "frontmatter", harness, f"{name}.{SRC_EXT[harness]}")


def compose(root: str, harness: str, name: str) -> str:
    if harness in TOML_HARNESSES:
        return compose_toml(root, harness, name)
    return compose_md(root, harness, name)


def agent_names(root: str) -> list:
    bodies_dir = os.path.join(root, "src", "agents", "bodies")
    return sorted(
        f[:-3] for f in os.listdir(bodies_dir) if f.endswith(".md")
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="generate_agent_definitions.py")
    parser.add_argument("--root", default=".")
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify generated files match the sources; exit 1 on drift",
    )
    args = parser.parse_args(argv)
    root = args.root

    stale = []
    for name in agent_names(root):
        for harness in HARNESSES:
            fm_path = source_path(root, harness, name)
            if not os.path.exists(fm_path):
                print(
                    f"generate_agent_definitions: ERROR: missing {fm_path}",
                    file=sys.stderr,
                )
                return 1
            try:
                content = compose(root, harness, name)
            except ValueError as exc:
                print(f"generate_agent_definitions: ERROR: {exc}", file=sys.stderr)
                return 1
            out_path = os.path.join(root, OUT_DIRS[harness], f"{name}.{OUT_EXT[harness]}")
            if args.check:
                try:
                    with open(out_path, "r", encoding="utf-8") as f:
                        current = f.read()
                except OSError:
                    current = ""
                if current != content:
                    stale.append(out_path)
            else:
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                with open(out_path, "w", encoding="utf-8") as f:
                    f.write(content)
                print(f"generate_agent_definitions: wrote {out_path}", file=sys.stderr)

    if args.check:
        if stale:
            print(
                "generate_agent_definitions: STALE (re-run "
                f"src/scripts/validate/generate_agent_definitions.py): {', '.join(stale)}",
                file=sys.stderr,
            )
            return 1
        print("generate_agent_definitions: check OK", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
