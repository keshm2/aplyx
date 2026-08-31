# src/agents/: single source of truth for agent behavior

The per-harness agent definitions are **generated**; never edit
`.opencode/agents/*` or `.claude/agents/*` directly.

- `bodies/<name>.md`: the harness-neutral prompt body (the behavior).
- `frontmatter/opencode/<name>.yaml`: opencode frontmatter (models,
  temperature, mode). Model IDs here are the operator's local choice
  until the phase 12 tier registry lands.
- `frontmatter/claude/<name>.yaml`: Claude Code frontmatter
  (`model: inherit`; the runtime model comes from the user's Claude
  Code session, never pinned here).
- `skills/<name>/SKILL.md`: bundled skills: reusable checklists/
  protocols a body reads and applies inline for one step of its own
  process (not themselves invocable subagents). Not compiled into
  `.opencode/agents/`/`.claude/agents/`; bodies reference the file path
  directly, so behavior is identical across every harness regardless of
  native skill-tool support. See `skills/README.md` for the index and
  how to add one.

Regenerate after editing any source:

```bash
python3 src/scripts/validate/generate_agent_definitions.py          # write
python3 src/scripts/validate/generate_agent_definitions.py --check  # drift check (CI / pre-run)
```

`src/scripts/runtime/run_job_agent.sh` runs the drift check at the start of every
run and warns (does not block) when the generated files are stale.

Harness capability contract (what a driver must provide): subagent
invocation, a shell tool, file read/write, and Playwright MCP for
browser-driven boards. Both opencode and Claude Code provide all four;
a harness missing browser automation must degrade to API-fed boards
plus review-only routing (see PLAN.md phase 16).
