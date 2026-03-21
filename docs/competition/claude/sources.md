# Claude Code Sources

Reviewed on 2026-03-20.

## Primary repos

- repo: `https://github.com/anthropics/claude-code`
- checkout: `../happy-adjacent/research/claude-code`
- commit: `6aadfbdca2c29f498f579509a56000e4e8daaf90`

- repo: `https://github.com/zed-industries/claude-code-acp`
- checkout: `../happy-adjacent/research/claude-code-acp`
- commit: `521d1f766d421f8d21d162e1c799edc094781dfc`

- repo: `https://github.com/agentclientprotocol/agent-client-protocol`
- checkout: `../happy-adjacent/research/agent-client-protocol`
- commit: `cd10d9b86e04caaf05bd5e75d860da4c17fcd2f8`

## Local sources

- `~/.claude/teams/`
- `~/.claude/tasks/`
- `~/.claude/projects/`
- `docs/research/agent-teams-claude-code.md`

## Primary files inspected

- `../happy-adjacent/research/claude-code/CHANGELOG.md`
- `../happy-adjacent/research/claude-code/plugins/plugin-dev/skills/hook-development/SKILL.md`
- `../happy-adjacent/research/claude-code/plugins/plugin-dev/skills/agent-development/SKILL.md`
- `../happy-adjacent/research/claude-code/examples/settings/README.md`
- `../happy-adjacent/research/claude-code/examples/settings/settings-bash-sandbox.json`
- `../happy-adjacent/research/claude-code/examples/settings/settings-strict.json`
- `../happy-adjacent/research/claude-code-acp/src/acp-agent.ts`
- `../happy-adjacent/research/claude-code-acp/src/settings.ts`
- `../happy-adjacent/research/agent-client-protocol/src/agent.rs`
- `../happy-adjacent/research/agent-client-protocol/src/client.rs`
- `../happy-adjacent/research/agent-client-protocol/src/tool_call.rs`
- `docs/research/agent-teams-claude-code.md`

## Notes

- Claude requires combining public repo docs, ACP adapter code, ACP spec, changelog notes, and local filesystem state.
- That split is itself an important product/protocol observation.
