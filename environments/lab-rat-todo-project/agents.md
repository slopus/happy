# Lab Rat Todo Project — Agent Instructions

This is a **test fixture**, not a real product. It exists so we can exercise
coding agents (Claude Code, OpenCode, Codex, Happy, etc.) against a small but
realistic codebase and observe their protocol behavior end to end.

## What this project is

A tiny frontend-only todo app. Four files, no build step, no dependencies.
Opens in a browser via `index.html`. Stores todos in localStorage.

## What you should know

- There is a **bug**: the "Done" filter shows all items instead of only
  completed ones. The filter string comparison in `app.js` is wrong.
- There is **no dark mode** even though the CSS has `color-scheme: light` —
  dark mode is a reasonable feature to add.
- There are **no tests** and no test framework configured.
- The **delete button has no confirmation** — it just removes the item.
- There is **no keyboard shortcut** to add a todo (e.g. Cmd+Enter from
  anywhere on the page).

## How agents should use this

Work through `exercise-flow.md` — it is a scripted sequence of 20 realistic
user interactions designed to exercise every protocol primitive a coding agent
supports. Each step has a clear expected outcome.

Do not skip steps. Do not batch steps. Execute them one at a time and observe
what happens at the protocol level.
