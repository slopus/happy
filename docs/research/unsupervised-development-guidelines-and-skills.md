# Unsupervised Development Guidance and Skills Ecosystem

Research summary as of 2026-03-06.

## Why this note exists

Happy already has the runtime pieces needed for long-running and partially unsupervised agent work, but the guidance for how to operate, validate, and trust those workflows is scattered. This note captures:

- what is documented today in this repository
- what is missing for unsupervised development guidance
- what a stronger adjacent process looks like
- what the current skills ecosystem suggests for reusable agent procedures

## What Happy documents today

The strongest documentation in this repository is about runtime behavior, not operator process.

- [`../cli-architecture.md`](../cli-architecture.md) explains the CLI, daemon, and machine/session lifecycle.
- [`../permission-resolution.md`](../permission-resolution.md) explains how permission mode is derived from app state, CLI flags, and sandbox policy.
- [`../session-protocol.md`](../session-protocol.md) defines the unified event stream for user, agent, tool, turn, and subagent events.
- [`../session-protocol-claude.md`](../session-protocol-claude.md) explains how Claude local and remote launchers map provider events into the session protocol.
- [`agent-teams-claude-code.md`](./agent-teams-claude-code.md) captures research on Claude Code agent teams and on-disk subagent state.

There are also package-level agent instruction files:

- [`../../packages/happy-cli/CLAUDE.md`](../../packages/happy-cli/CLAUDE.md)
- [`../../packages/happy-app/CLAUDE.md`](../../packages/happy-app/CLAUDE.md)
- [`../../packages/happy-server/CLAUDE.md`](../../packages/happy-server/CLAUDE.md)

These are useful as local coding guidance, but they are not a coherent unsupervised-development handbook. In practice, the CLI one is also stale enough to still refer to `handy-cli`, so it should not be treated as the canonical source for current behavior.

## How unsupervised development currently works in Happy

Based on the current docs and codebase structure, the operating model is roughly:

1. The user starts `happy`, `happy codex`, `happy gemini`, or another wrapped agent flow.
2. The CLI either runs the agent directly or starts/uses the daemon, depending on context.
3. The daemon tracks child sessions and machine state and exposes local control endpoints.
4. Remote/mobile clients can steer sessions and respond to permission requests.
5. Permission behavior is resolved from session metadata, CLI flags, and sandbox rules.
6. The session protocol carries user messages, agent turns, tool calls, files, and subagent events.
7. Provider-specific adapters map raw provider logs and streams into that unified protocol.

Important consequence: Happy already has a protocol-level understanding of subagents and tool-spawned sidechains. The missing layer is not transport. The missing layer is process: when unsupervised operation is allowed, how it is validated, and what counts as evidence that it is safe and working.

## What is missing

There is no single document that answers these operator questions:

- What counts as an approved unsupervised workflow in Happy?
- Which modes are safe only with sandboxing, and which require human approval?
- What is the required validation loop before trusting an autonomous flow?
- How should regressions be tracked and replayed?
- What artifacts should be captured from autonomous runs?
- When should subagents be used, and what kinds of specialization are encouraged?

There is also no explicit process split between:

- a developer agent
- a planner or task-picker
- a QA verifier
- a janitor or process-fixer
- a review role

That means Happy has the runtime for autonomous behavior, but not the operating manual.

## Adjacent process inspiration

An adjacent local project explored during this research used a much stricter agent process. The specific repository is not linked here because it is local-only, but the useful patterns are:

- a top-level `agents.md` that defines the autonomous loop and hard rules
- separate developer and QA role documents
- a `current-state` document that is treated as the source of truth for what actually works
- deterministic environment setup and lifecycle guidance
- rollout folders with plan, log, issues faced, artifacts, and final report
- a janitor feedback loop that proposes process fixes based on repeated mistakes

The most important ideas worth copying into Happy are:

- **Current-state ledger**: a brutally honest document of what actually works today, backed by evidence
- **Role separation**: development, QA, review, and process-cleanup should not be implicit
- **Evidence-first acceptance**: terminal + UI + daemon + network flows should be verified end-to-end
- **Process feedback loop**: if agents repeatedly fail the same way, fix the process docs, not just the code

## Skills ecosystem findings

### `npx skills`

The clearest match for "npx skills" is the npm package [`skills`](https://www.npmjs.com/package/skills), version `1.4.4` as of 2026-03-06.

Repository:

- <https://github.com/vercel-labs/skills>

Useful properties:

- installs skills from GitHub, GitLab, git URLs, or local paths
- supports project-local and global install scopes
- recommends symlink-based installs as the default model
- supports many agent runtimes, including Claude Code, Codex, OpenClaw, Cursor, Command Code, and others
- treats skills as directories containing `SKILL.md`
- supports selective install, listing, search, update, remove, and bootstrap commands

The main product insight is that skills are treated as reusable procedures that can be shared across agent runtimes without embedding the procedures in the main system prompt.

### Agent Skills standard

The broader specification is documented here:

- <https://agentskills.io>

Useful ideas from the standard:

- skills are portable, version-controlled knowledge packages
- skills are load-on-demand rather than always inlined
- the format is meant to be open and shared across agent products
- skills can capture domain expertise, new capabilities, and repeatable workflows

This matches Happy's needs well. Happy wraps multiple agents already, so a portable procedural layer is more valuable than yet another provider-specific prompt convention.

### Anthropic custom subagents

Anthropic's current docs:

- <https://code.claude.com/docs/en/sub-agents>

Useful ideas:

- subagents should be specialized rather than generic
- context should be delegated intentionally
- subagents are useful for task-specific workflows and context management
- hooks and tool restrictions matter when delegating work

This lines up with Happy's existing protocol support for `subagent` event streams. The runtime already understands subagent identity; the missing piece is guidance for when and how to use that capability well.

## Implications for Happy

The practical conclusion is:

- Happy does **not** need to invent subagent transport first.
- Happy does **not** primarily need more architecture docs.
- Happy **does** need an operator/process layer for autonomous work.

The first useful documentation pass would be:

1. `docs/autonomous-development.md`
   - allowed autonomy modes
   - human approval boundaries
   - sandbox expectations
   - when remote control is required
2. `docs/autonomous-validation.md`
   - minimum validation loop
   - required evidence
   - replay/regression requirements
   - daemon/network/provider failure cases to exercise
   - slash-command behavior in non-interactive sessions: verify what happens when agent-native `/commands` are sent through remote or headless flows, including whether they execute, fail cleanly, or are surfaced back to the user without corrupting session state
   - include explicit regression cases for stateful commands such as `/clear`, which should either truly reset session context in non-interactive flows or be rejected in a way that is visible and unambiguous to the user
3. `docs/skills-and-subagents.md`
   - when to use a skill vs a subagent
   - naming and specialization guidance
   - project-local vs global skills
   - how Happy should interoperate with existing agent skill directories

## Recommended design direction

If Happy decides to adopt skills more explicitly, the most compatible path is likely:

- support the standard `SKILL.md` format rather than inventing a new one
- prefer project-local skill installation for reproducible teams
- allow global skills for personal workflows
- map onto the native skill directories already used by wrapped agents where possible
- keep Happy focused on orchestration, observability, and validation rather than becoming a separate skill runtime

That approach keeps Happy aligned with the broader ecosystem while preserving its real value: remote control, daemonized execution, protocol normalization, and session observability across providers.

## Bottom line

Happy currently has the substrate for unsupervised development, but not the handbook.

The strongest next step is to document:

- what autonomous operation is allowed
- how it must be validated
- how regressions are recorded
- how subagents and skills should be used
- how CLI agents behave when slash commands are sent in non-interactive sessions

Without that layer, the system remains operable but underspecified.
