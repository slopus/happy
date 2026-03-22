# OpenCode

Reviewed on 2026-03-21 from `../happy-adjacent/research/opencode` at commit
`2e0d5d230893dbddcefb35a02f53ff2e7a58e5d0`.

## Why it matters

OpenCode is currently the strongest overall product reference for Happy.

- the desktop UI is excellent
- the feature set feels coherent and ambitious
- clicking the context field opens a genuinely useful debug/context inspector
- the transcript and sync model look much closer to what Happy should want than a flat custom message stream

## Current take

- Use OpenCode as the leading reference for transcript design.
- Strongly consider adopting its message-and-parts direction instead of inventing another bespoke message protocol.
- Keep digging into how it syncs state between client and server; there is a lot to learn there.
- Read `runtime-tracing.md` first if you want the real story. That file now has
  concrete permission, media, subtask, and routing flows with actual payload
  snippets from a source-run OpenCode server.

## Key findings

- transcript model: stable message envelopes with ordered typed parts
- live updates: incremental SSE-style event stream plus paged fetch hydration
- subagents: child sessions created through the `task` tool, resumable by `task_id`
- task tracking: first-class todo store, not buried in message text
- permissions: first-class request objects plus pattern rules and decision history
- sandbox: workspace/worktree isolation, not a strict OS sandbox

## Important repo files

- `../happy-adjacent/research/opencode/packages/opencode/src/session/message-v2.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/session/index.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/tool/task.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/tool/todo.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/permission/index.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/control-plane/workspace-server/routes.ts`
- `../happy-adjacent/research/opencode/packages/app/src/components/session/session-context-tab.tsx`

See `docs/competition/opencode/message-protocol.md`,
`docs/competition/opencode/runtime-tracing.md`, and
`docs/competition/opencode/sources.md`.
