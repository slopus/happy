# Claude Code Protocol and Control Surface

## Bottom line

Claude Code is not one protocol. It is several layers:

- ACP for clean client/agent session control
- hook JSON for event interception and policy
- local `~/.claude/` files for rich team and subagent state
- product behavior documented partly in changelog and settings examples

That makes it powerful, but harder to copy cleanly.

## ACP session protocol

ACP is the cleanest part of the Claude stack.

- ACP is JSON-RPC
- sessions stream updates through `session/update`
- updates include user chunks, agent chunks, thoughts, tool calls, tool call updates, plans, current mode updates, config option updates, and session info
- prompt execution, cancel, load, resume, fork, close, and list are all explicit protocol operations

Primary source files:

- `../happy-adjacent/research/agent-client-protocol/src/agent.rs`
- `../happy-adjacent/research/agent-client-protocol/src/client.rs`
- `../happy-adjacent/research/agent-client-protocol/src/tool_call.rs`

## Claude ACP adapter behavior

The Claude ACP adapter maps Claude Code behavior into ACP.

- permission modes such as `default`, `acceptEdits`, `plan`, `dontAsk`, and `bypassPermissions` are surfaced through ACP-facing controls
- mode and model configuration are emitted as config options and current-mode updates
- additional workspace scope is passed through `_meta.additionalRoots`
- session create, load, resume, replay, and fork are implemented in the adapter layer

This is important for Happy because it shows where clean protocol stops and provider-specific behavior begins.

Primary source files:

- `../happy-adjacent/research/claude-code-acp/src/acp-agent.ts`
- `../happy-adjacent/research/claude-code-acp/src/settings.ts`

## Hook/event protocol

Claude has a separate typed event surface for hooks.

- hook input includes `session_id`, `transcript_path`, `cwd`, `permission_mode`, and `hook_event_name`
- hook events include `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`, and `Notification`
- changelog notes add additional events such as `PermissionRequest`, `SubagentStart`, `TeammateIdle`, and `TaskCompleted`
- hook outputs can allow, deny, ask, suppress output, or inject system messages

This is one of the best pieces of Claude's design: event interception is explicit.

Primary source files:

- `../happy-adjacent/research/claude-code/plugins/plugin-dev/skills/hook-development/SKILL.md`
- `../happy-adjacent/research/claude-code/CHANGELOG.md`

## Subagents and task tracking

Claude is strongest here at the product level, but the state lives in several places.

- custom agents are markdown-defined with frontmatter such as `name`, `description`, `model`, `color`, and optional tool restrictions
- the `Task` tool launches or communicates with agents
- local team state lives under `~/.claude/teams/`
- local task queue state lives under `~/.claude/tasks/`
- subagent conversation chains live under `~/.claude/projects/.../subagents/`

The main lesson for Happy is not to copy the hidden-file layout. The lesson is to
keep agent identity, team membership, and task lifecycle explicit.

Primary source files:

- `../happy-adjacent/research/claude-code/plugins/plugin-dev/skills/agent-development/SKILL.md`
- `docs/research/agent-teams-claude-code.md`
- `~/.claude/teams/`
- `~/.claude/tasks/`

## Permissions and mode switching

Claude treats this as real state, not a prompt-only convention.

- settings files define ask/deny policy and whether bypass mode is allowed
- `PreToolUse` hooks can make permission decisions
- dedicated `PermissionRequest` hooks can also approve or deny
- plan mode is a real runtime mode, not just different wording
- custom agents can carry their own permission mode

This is a strong pattern for Happy: mode and permission state should be first-class and inspectable.

Primary source files:

- `../happy-adjacent/research/claude-code/examples/settings/settings-strict.json`
- `../happy-adjacent/research/claude-code/plugins/plugin-dev/skills/hook-development/SKILL.md`
- `../happy-adjacent/research/claude-code/CHANGELOG.md`

## Sandbox and workspace controls

Claude's safety story is layered.

- shell sandboxing is focused mainly on `Bash`
- settings include network allowlists, command exclusions, and nested sandbox behavior
- additional read/write controls and protected directories exist
- workspace trust is a separate gate from sandboxing

This is less unified than Codex's sandbox policy, but still better than pretending all tool safety is the same thing.

Primary source files:

- `../happy-adjacent/research/claude-code/examples/settings/README.md`
- `../happy-adjacent/research/claude-code/examples/settings/settings-bash-sandbox.json`
- `../happy-adjacent/research/claude-code/CHANGELOG.md`

## Resume, fork, and lifecycle

Claude clearly treats session lifecycle as a product priority.

- session start/end and compaction have hook events
- resume and continue have many changelog fixes around transcript restoration and tool-result replay
- fork was renamed to branch and needed isolation fixes
- sessions support naming and named resume
- local per-session state is often keyed by `session_id`

This is a reminder for Happy that resume correctness is not a small detail; it is a protocol feature.

## Remote and sync implications

Claude is the weakest clean reference here.

- ACP is promising for remote control and agent interoperability
- there is a remote-control bridge to `claude.ai/code`
- MCP networking is well-documented
- but the richest team and subagent state still lives in local files under `~/.claude/`

So Claude is useful as a workflow reference, but not the best single source for Happy's own sync protocol.

## What Happy should steal

- first-class mode and permission state
- typed event interception around tools and lifecycle
- strong subagent identity and task lifecycle concepts
- explicit resume/fork semantics
- do not copy the dependency on hidden local files as the main state model
