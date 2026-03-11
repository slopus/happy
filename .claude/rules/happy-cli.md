---
paths:
  - packages/happy-cli/**
---

## Gotchas

- ALL imports must be at the top of the file — never import mid-code
- All debugging goes through file-based logger — never use console for debug output (interferes with agent terminal UI)
- Dual mode architecture: interactive mode spawns CLI process (child_process.spawn, NOT node-pty), remote mode uses internal SDK (`src/claude/sdk/`)
- Claude SDK is internal (`src/claude/sdk/`), not the `@anthropic-ai/claude-code` npm package

## Patterns to Follow

- Named exports only (no default exports)
- As few `if` statements as possible — prefer better design over control flow branching
- Don't create trivial small functions / getters / setters
- Daemon logs default to `~/.happy/logs/` (or `$HAPPY_HOME_DIR/logs/`)
