# src/agents/skills/ — bundled skills library

Reusable behavior modules that agent bodies (`src/agents/bodies/*.md`)
reference by file path and apply inline. Unlike `bodies/` (one file =
one runnable subagent) and `frontmatter/` (per-harness invocation
metadata), a skill is not itself invocable — it's a checklist/protocol a
body pulls in for one step of its own process.

This exists because not every harness aplyx runs on has a native
"Skill" concept (see AGENTS.md's harness capability matrix). Bundling
skills as plain markdown that any body can `Read` and apply directly
keeps behavior identical across opencode, Claude Code, Codex CLI, and
Copilot CLI, the same way the "no subagent registry" degraded path
works: read the file, follow it inline, no harness-specific plumbing.

## Available skills

| Skill | Purpose | Used by |
| --- | --- | --- |
| `humanizer/` | Strip AI-writing tells (power-verb rotation, buzzword stacking, inflated-metric templates, filler, em-dash overuse) from tailored resume bullets and cover letters — style only, never adds a fact or number. | `resume-tailor`, `cover-letter-tailor` |

## Adding a new skill

1. Create `src/agents/skills/<name>/SKILL.md` with a frontmatter block
   (`name`, `version`, `scope`, `used_by`, `description`) and the
   protocol body, same shape as `humanizer/SKILL.md`.
2. Reference it from whichever `bodies/<name>.md` file(s) should apply
   it — an explicit step naming the file path, since bodies run across
   all four harnesses and can't assume a native skill-invocation tool.
3. Add a row to the table above.
4. No regeneration step needed — skills aren't compiled into
   `.opencode/agents/` or `.claude/agents/`; bodies read them directly
   at runtime via the file path.
