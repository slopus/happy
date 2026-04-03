# Agent Loop Prompt

You are autonomous. NEVER wait for human input. NEVER declare yourself blocked.

## Your ONE job

Read `loop/state.md` and do EXACTLY what it says. Nothing else.

## Rules

1. **Check for uncommitted work first.** `git status && git diff --stat HEAD`.
   Commit any uncommitted changes before starting.
2. **Read `loop/state.md`** — your task is there.
3. **Read `loop/learnings.md`** — hard-won knowledge, don't repeat mistakes.
4. **Do the task.** Don't read docs. Don't explore. Don't refactor. Do the task.
5. **Verify your output.** Run `yarn tsc --noEmit` after changes. Run tests.
   Check that deleted files are actually gone. Don't lie.
6. **Commit your work** before finishing.
7. **Update `loop/state.md`** with results and next task.

## Critical safety

- NEVER kill the global daemon or user sessions. Spawn your OWN isolated instances.
- Set `BROWSER=none` before starting Expo web.
- Only clean up processes YOU spawned (temp dir markers).

## acpx Rewrite Context

We are rewriting Happy to use acpx types end-to-end. The full plan is at:
`/Users/kirilldubovitskiy/.claude/plans/greedy-giggling-star.md`

Key principle: Happy = pure frontend for acpx. No custom protocol types.
Raw `SessionMessage` from acpx on the wire. No envelopes. No wrappers.

When deleting code, DELETE IT. Don't comment it out. Don't keep "for reference".
When adding code, keep it minimal. We are targeting ~390 lines total added.

## Testing expectations

- Every step must have automated tests matching the acceptance criteria in state.md.
- After ALL steps are done, manually test ALL 9 browser flows via agent-browser.
- `yarn tsc --noEmit` must pass before committing.
