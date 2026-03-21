# Competitor Protocol Matrix

Reviewed on 2026-03-20.

This is the short version of what matters most for Happy.

| Vendor | Core transport | Transcript shape | Subagents / tasks | Permissions | Sandbox story | Sync / remote story | Happy takeaway |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode | HTTP + SSE | message envelope + typed parts | child sessions via `task` tool | first-class request objects + rules | worktree/workspace isolation, not OS sandbox | strong client/server split with event stream + fetch hydration | best overall product and protocol reference right now |
| Codex | JSON-RPC 2.0 over stdio or websocket | typed `thread` / `turn` / `item` graph | typed collab-agent items | explicit server requests for approvals | strongest real sandbox policy surface of the three | robust live subscription, replay, resume, overload handling | best backend protocol reference |
| Claude | ACP JSON-RPC plus local filesystem state | streamed session updates + local transcript files | agent teams, inboxes, tasks, subagent JSONL | mode + permission are first-class, but split across ACP and local settings | narrower shell sandbox plus trust / permission layers | local-first, remote-control bridge exists, rich state still leaks to disk | best agent workflow reference, weaker as a single clean protocol |

## Current read

- OpenCode is the most attractive end-to-end reference for Happy right now.
- Codex has the cleanest typed app-server model for thread, turn, item, approval, and sandbox policy.
- Claude has the most mature agent-team workflow, but its useful state is split across ACP, hooks, changelog behavior, and `~/.claude/`.

## Suggested design direction for Happy

- Use OpenCode's envelope + typed-parts transcript model as the main UI/session protocol reference.
- Steal Codex's explicit server-request pattern for approvals and user input.
- Keep Claude's agent-team lessons, but avoid depending on hidden local files as the primary source of truth.
- Treat todos, permissions, questions, and subagents as first-class state channels, not assistant-text hacks.
- Study OpenCode's server sync path next; that looks like the highest-leverage follow-up.
