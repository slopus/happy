# Lab Rat Todo Project

A tiny frontend-only todo app. No build step, no dependencies. Opens via
`index.html`. Stores todos in localStorage.

## Purpose

This project exists to **exercise coding agents**. It is the standard test
fixture for Happy, OpenCode, Claude Code, Codex, and any other agent we want
to evaluate protocol behavior against.

It is intentionally small (4 source files) but has real bugs, missing features,
and enough surface area to trigger every protocol primitive an agent supports:
permissions, subagents, questions, todos, sandbox boundaries, compaction,
model switching, session resume.

## Files

- `index.html` — app shell
- `styles.css` — layout and theme
- `app.js` — todo logic and localStorage persistence
- `agents.md` — instructions for coding agents
- `CLAUDE.md` — points Claude Code to agents.md
- `exercise-flow.md` — 20-step scripted interaction sequence with expected
  outcomes and protocol primitive coverage

## Known issues (intentional)

- The "Done" filter is broken — shows all items instead of only completed ones
- No dark mode
- No tests or test framework
- No keyboard shortcuts
- Delete has no confirmation

These exist so agents have concrete work to do during the exercise.

## How to use

Point your agent at this directory and work through `exercise-flow.md`.
