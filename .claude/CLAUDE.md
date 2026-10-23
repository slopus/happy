# `.claude/` is a symlink farm — DO NOT EDIT FILES HERE

The Claude Code harness hard-codes `.claude/skills/` (and friends) as the
discovery path for agent skills. We don't want to duplicate skill content
across every harness's preferred directory, so the canonical location for
**all** agent skills in this repo is:

    .agents/skills/<name>/SKILL.md

`.claude/skills/<name>` is a **symlink** pointing at the corresponding
`.agents/skills/<name>` directory. The harness follows the symlink and
discovers the skill normally.

## Rules

```
.
├── editing a skill              → edit .agents/skills/<name>/SKILL.md
├── adding a new skill           → create .agents/skills/<name>/SKILL.md
│                                  AND ln -s ../../.agents/skills/<name>
│                                  inside .claude/skills/
├── editing .claude/skills/*     → DON'T. They're symlinks. Edits land
│                                  in the canonical .agents/ location
│                                  but you should still update via that
│                                  path so the intent is obvious in
│                                  diffs and PRs.
└── other harnesses (codex,      → add another symlink farm at the
    cursor, agent-browser, …)      harness's expected path. The
                                    canonical store stays in .agents/.
```

## Why we did this

The `.claude/` convention forces every project that uses Claude Code to
keep agent state inside a vendor-named directory. That's annoying when
the same agent files are useful to other harnesses, and it spreads the
"single source of truth" across paths nobody wants to duplicate. Putting
the canonical content in `.agents/` and symlinking from `.claude/` lets
us:

- Edit skills in one place and have every harness pick them up
- Avoid merge conflicts from copy-paste skill edits across directories
- Keep `.claude/` as a thin compatibility shim we can ignore in reviews

If a future harness needs its own skills directory, add another set of
symlinks pointing back at `.agents/skills/`. Don't move the canonical
files.

## Quick check

```bash
ls -la .claude/skills/
# every entry should be a symlink (lrwxr-xr-x) pointing at
# ../../.agents/skills/<name>
```

If you see real directories under `.claude/skills/`, someone forgot to
follow this convention — open an issue or fix it the same way the
existing entries are set up.
