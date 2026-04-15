# Competitor Protocol Matrix

Reviewed on 2026-03-20. Superset added 2026-04-08.

This is the short version of what matters most for Happy.

| Vendor | Core transport | Transcript shape | Subagents / tasks | Permissions | Sandbox story | Sync / remote story | Happy takeaway |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode | HTTP + SSE | message envelope + typed parts | child sessions via `task` tool | first-class request objects + rules | worktree/workspace isolation, not OS sandbox | strong client/server split with event stream + fetch hydration | best overall product and protocol reference right now |
| Codex | JSON-RPC 2.0 over stdio or websocket | typed `thread` / `turn` / `item` graph | typed collab-agent items | explicit server requests for approvals | strongest real sandbox policy surface of the three | robust live subscription, replay, resume, overload handling | best backend protocol reference |
| Claude | ACP JSON-RPC plus local filesystem state | streamed session updates + local transcript files | agent teams, inboxes, tasks, subagent JSONL | mode + permission are first-class, but split across ACP and local settings | narrower shell sandbox plus trust / permission layers | local-first, remote-control bridge exists, rich state still leaks to disk | best agent workflow reference, weaker as a single clean protocol |
| Superset | Hono HTTP + tRPC + WebSocket EventBus | opaque — doesn't parse agent output, observes lifecycle via hooks | agent-agnostic launch in real PTY + git worktree isolation per task | not applicable — delegates to each agent's own permission model | worktree isolation, agents run in real terminals with their own sandboxing | Electric SQL cloud→local sync + cloud DB command queue for CLI→desktop control + manifest-based host-service durability | best orchestration-layer reference; strongest package boundaries; Electric SQL sync and cloud command queue patterns worth studying |

## Current read

- OpenCode is the most attractive end-to-end reference for Happy right now.
- Codex has the cleanest typed app-server model for thread, turn, item, approval, and sandbox policy.
- Claude has the most mature agent-team workflow, but its useful state is split across ACP, hooks, changelog behavior, and `~/.claude/`.
- Superset is the strongest reference for orchestration-layer design — doesn't own agent protocols, just coordinates. Remarkable ship velocity (3 people, 2,100+ commits in 5 months).

## Suggested design direction for Happy

- Use OpenCode's envelope + typed-parts transcript model as the main UI/session protocol reference.
- Steal Codex's explicit server-request pattern for approvals and user input.
- Keep Claude's agent-team lessons, but avoid depending on hidden local files as the primary source of truth.
- Treat todos, permissions, questions, and subagents as first-class state channels, not assistant-text hacks.
- Study OpenCode's server sync path next; that looks like the highest-leverage follow-up.
- Evaluate Superset's Electric SQL cloud→local sync pattern and cloud DB command queue as alternatives to Happy's current sync approach.
- Consider Superset's host-service extraction pattern (injectable providers, manifest-based durability) for Happy's CLI/server split.
