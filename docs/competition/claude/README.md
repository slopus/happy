# Claude Code

Reviewed on 2026-03-20 from these main sources:

- `../happy-adjacent/research/claude-code` at `6aadfbdca2c29f498f579509a56000e4e8daaf90`
- `../happy-adjacent/research/claude-code-acp` at `521d1f766d421f8d21d162e1c799edc094781dfc`
- `../happy-adjacent/research/agent-client-protocol` at `cd10d9b86e04caaf05bd5e75d860da4c17fcd2f8`
- local `~/.claude/` state
- `docs/research/agent-teams-claude-code.md`

## Why it matters

Claude Code is the strongest workflow reference for agent teams and local agent
state, but it is not one clean protocol surface.

- ACP is reasonably clean
- hooks expose a typed event interface
- agent teams are powerful
- the richest state still leaks into `~/.claude/` files

## Current take

- Claude is a great source of ideas for agent teams, subagent identity, and permission/mode control.
- Claude is a worse reference for a single canonical session protocol than OpenCode or Codex.
- If Happy borrows from Claude, it should borrow product behavior and workflow ideas, not the hidden local-state dependency.

## Important sources

- `../happy-adjacent/research/claude-code/CHANGELOG.md`
- `../happy-adjacent/research/claude-code/plugins/plugin-dev/skills/hook-development/SKILL.md`
- `../happy-adjacent/research/claude-code/plugins/plugin-dev/skills/agent-development/SKILL.md`
- `../happy-adjacent/research/claude-code/examples/settings/README.md`
- `../happy-adjacent/research/claude-code-acp/src/acp-agent.ts`
- `../happy-adjacent/research/agent-client-protocol/src/agent.rs`
- `../happy-adjacent/research/agent-client-protocol/src/client.rs`
- `docs/research/agent-teams-claude-code.md`

See `docs/competition/claude/message-protocol.md` and
`docs/competition/claude/sources.md`.
