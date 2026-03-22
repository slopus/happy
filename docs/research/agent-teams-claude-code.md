# Claude Code Agent Teams — Internal Architecture

Research compiled from on-disk exploration of `~/.claude/` and web sources.

## File Structure

```
~/.claude/
├── teams/{team-name}/
│   ├── config.json                # Team membership & configuration
│   └── inboxes/
│       ├── {agent-name}.json      # Per-agent message inbox (JSON array)
│       └── team-lead.json         # Lead's inbox (receives idle notifications, etc.)
├── tasks/{team-name}/
│   ├── .lock                      # File-based concurrency lock
│   ├── 1.json                     # Individual task files
│   └── N.json
├── projects/{project-path}/
│   └── {sessionId}/
│       └── subagents/
│           └── agent-{hash}.jsonl # One JSONL per agent turn chain
├── settings.json                  # Contains feature flag
└── debug/{sessionId}.txt          # Debug logs
```

## Feature Flag

In `~/.claude/settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

## Environment Variables Injected Into Agents

Each spawned agent receives:
- `CLAUDE_CODE_TEAM_NAME`
- `CLAUDE_CODE_AGENT_ID`
- `CLAUDE_CODE_AGENT_NAME`
- `CLAUDE_CODE_AGENT_TYPE`
- `CLAUDE_CODE_AGENT_COLOR`
- `CLAUDE_CODE_PLAN_MODE_REQUIRED`

---

## 1. Team Config — `config.json`

**Path**: `~/.claude/teams/{team-name}/config.json`

```json
{
  "name": "ping-pong",
  "description": "Ping-Pong agent demo: Ping lists directory, sends to Pong, Pong writes /tmp/test-pong.md",
  "createdAt": 1772096708635,
  "leadAgentId": "team-lead@ping-pong",
  "leadSessionId": "ddf0a0fe-0fa7-4410-847b-fffee3ba2a71",
  "members": [
    {
      "agentId": "team-lead@ping-pong",
      "name": "team-lead",
      "agentType": "team-lead",
      "model": "claude-opus-4-6",
      "joinedAt": 1772096708635,
      "tmuxPaneId": "",
      "cwd": "/Users/.../happy",
      "subscriptions": []
    },
    {
      "agentId": "ping@ping-pong",
      "name": "ping",
      "agentType": "general-purpose",
      "model": "claude-opus-4-6",
      "prompt": "You are the \"ping\" agent...",
      "color": "blue",
      "planModeRequired": false,
      "joinedAt": 1772096726394,
      "tmuxPaneId": "in-process",
      "cwd": "/Users/.../happy",
      "subscriptions": [],
      "backendType": "in-process"
    }
  ]
}
```

**Key fields**:
- `agentId` format: `{name}@{team-name}`
- `agentType`: `"team-lead"` or `"general-purpose"` (or other built-in types)
- `backendType`: `"in-process"` (same Node.js process) or tmux/iTerm2 pane ID
- `tmuxPaneId`: `"in-process"` when running in-process, otherwise the actual pane ID
- `prompt`: Full initial instructions given to the agent at spawn time
- `color`: Used for UI display of messages from this agent

---

## 2. Inbox / Mailbox — `inboxes/{agent-name}.json`

**Path**: `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`

Each agent has one inbox file — a JSON array of message objects.

```json
[
  {
    "from": "ping",
    "text": "Here is the directory listing for /Users/.../happy:\n\ncli\nDockerfile\n...",
    "summary": "Directory listing sent to pong",
    "timestamp": "2026-02-26T09:05:36.225Z",
    "color": "blue",
    "read": true
  },
  {
    "from": "team-lead",
    "text": "{\"type\":\"shutdown_request\",\"requestId\":\"shutdown-1772096766848@pong\",\"from\":\"team-lead\",...}",
    "timestamp": "2026-02-26T09:06:06.849Z",
    "read": true
  }
]
```

**Key observations**:
- Regular messages have `text`, `summary`, and `color` fields
- Protocol messages (`shutdown_request`, `idle_notification`, etc.) are JSON-encoded strings in the `text` field
- `read: true/false` tracks delivery status
- Messages are appended to the array (O(N) per write — read entire file, parse, append, rewrite)

---

## 3. Task Files — `{id}.json`

**Path**: `~/.claude/tasks/{team-name}/{id}.json`

### User-created task
```json
{
  "id": "1",
  "subject": "Ping: List directory and send to Pong",
  "description": "List the current working directory contents and send the result to the Pong agent via SendMessage. Stay alive after sending.",
  "activeForm": "Sending directory listing to pong",
  "owner": "ping",
  "status": "completed",
  "blocks": [],
  "blockedBy": []
}
```

### Auto-created internal task (for agent lifecycle tracking)
```json
{
  "id": "3",
  "subject": "ping",
  "description": "You are the \"ping\" agent on team \"ping-pong\". Your job:...",
  "status": "in_progress",
  "blocks": [],
  "blockedBy": [],
  "metadata": {
    "_internal": true
  }
}
```

**Task states**: `pending` → `in_progress` → `completed`

**Concurrency**: `.lock` file in the tasks directory for file-based locking when multiple agents try to claim tasks.

**Dependency management**: `blocks` and `blockedBy` arrays of task IDs. When a blocking task completes, blocked tasks become available.

---

## 4. Subagent Session Histories — JSONL Files

**Path**: `~/.claude/projects/{project-path}/{sessionId}/subagents/agent-{hash}.jsonl`

Each line is a JSON object representing one conversation turn:

```json
{
  "parentUuid": "uuid-of-prior-turn",
  "isSidechain": true,
  "userType": "external",
  "cwd": "/Users/.../happy",
  "sessionId": "ddf0a0fe-...",
  "version": "2.1.59",
  "gitBranch": "feat/openclaw-backend",
  "agentId": "ae4751a370100782f",
  "slug": "wondrous-shimmying-mccarthy",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<teammate-message teammate_id=\"ping\" color=\"blue\">...</teammate-message>"
  },
  "uuid": "unique-uuid",
  "timestamp": "2026-02-26T09:05:38.123Z"
}
```

**Turn types**:
- `"type": "user"` — incoming messages (teammate messages wrapped in `<teammate-message>` XML, or tool results)
- `"type": "assistant"` — Claude API response with `content` array of `text` and/or `tool_use` blocks, plus `usage` stats
- `"type": "progress"` — hook progress events

**Critical insight**: Each incoming teammate message delivery creates a **new JSONL file** (a new turn chain). An agent does NOT have one continuous JSONL — it gets multiple files, one per wake-up.

---

## 5. Tool Calls — The API Surface

### Team Lifecycle

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `TeamCreate` | Create team + task list | `team_name`, `description` |
| `TeamDelete` | Remove team + task dirs | (none — uses current team context) |

### Agent Spawning

Agents are spawned via the `Task` tool with `team_name` and `name` parameters:

```
Task({
  name: "ping",
  description: "Ping agent",
  prompt: "You are the ping agent...",
  subagent_type: "general-purpose",
  team_name: "ping-pong",
  run_in_background: true
})
```

### Messaging — `SendMessage`

```
// Direct message
SendMessage({
  type: "message",
  recipient: "pong",
  content: "Here is the directory listing...",
  summary: "Directory listing sent"
})

// Broadcast to all
SendMessage({
  type: "broadcast",
  content: "Critical update",
  summary: "Blocking issue found"
})

// Request shutdown
SendMessage({
  type: "shutdown_request",
  recipient: "pong",
  content: "Work complete, please shut down"
})

// Approve shutdown (called by the agent being shut down)
SendMessage({
  type: "shutdown_response",
  request_id: "shutdown-1772096766848@pong",
  approve: true
})

// Plan approval
SendMessage({
  type: "plan_approval_response",
  request_id: "abc-123",
  recipient: "researcher",
  approve: true
})
```

### Task Management

```
// Create task
TaskCreate({
  subject: "Ping: List directory and send to Pong",
  description: "List the current working directory...",
  activeForm: "Listing directory and sending to Pong"
})

// Update task (claim, complete, add dependencies)
TaskUpdate({
  taskId: "1",
  status: "in_progress",
  owner: "ping"
})

TaskUpdate({
  taskId: "1",
  status: "completed"
})

TaskUpdate({
  taskId: "2",
  addBlockedBy: ["1"]  // Task 2 waits for task 1
})

// List all tasks
TaskList()

// Get single task
TaskGet({ taskId: "1" })
```

---

## 6. Internal Operations (13 total, from binary analysis)

| Category | Operations |
|----------|-----------|
| **Lifecycle** | `spawnTeam`, `discoverTeams`, `requestJoin`, `approveJoin`, `rejectJoin`, `cleanup` |
| **Communication** | `write` (DM), `broadcast` (all) |
| **Plan approval** | `approvePlan`, `rejectPlan` |
| **Shutdown** | `requestShutdown`, `approveShutdown`, `rejectShutdown` |

---

## 7. Backend Modes

| Mode | Detection | How agents run |
|------|-----------|----------------|
| **in-process** | Default fallback | Async tasks in same Node.js process |
| **tmux** | Inside tmux session | Separate tmux panes, visible |
| **iTerm2** | macOS iTerm2 detected | Split panes via `it2` CLI |

Configurable via `teammateMode` in `settings.json` or `--teammate-mode` CLI flag.

---

## 8. Built-in Agent Types

| Type | Capabilities |
|------|-------------|
| `general-purpose` | Full tool access (read, write, edit, bash, etc.) |
| `Explore` | Read-only, fast codebase analysis |
| `Plan` | Architecture/strategy design, no file writes |
| `Bash` | Shell commands only |
| `claude-code-guide` | Questions about Claude Code itself |

Custom agents can be defined in `.claude/agents/` with their own tool restrictions.

---

## 9. Coordination Patterns

| Pattern | Description |
|---------|-------------|
| **Leader** | Hierarchical — lead directs specialists, they report back |
| **Swarm** | Self-organizing — agents poll TaskList, claim pending tasks |
| **Pipeline** | Sequential — tasks chain via `blockedBy`, auto-unblock on completion |
| **Watchdog** | Quality monitoring — dedicated agent reviews others' work |
| **Council/Debate** | Competing hypotheses — agents argue and disprove each other |

---

## 10. Ping-Pong Validation Test (2026-02-26)

Ran the same prompt through two modes to validate team behavior end-to-end:

```
Create a team called 'ping-pong' and have them ping pong once through message bus and shut down and report
```

### Non-interactive (`claude -p`)

```bash
claude -p "Create a team called 'ping-pong' and have them ping pong once through message buss and shut down and report"
```

**Result**: Team created successfully. The full ping-pong exchange completed in ~13 seconds:

| Time (UTC) | Event |
|------------|-------|
| 10:21:06 | ponger spawned, goes idle (waiting) |
| 10:21:08 | pinger sends **"PING"** to ponger |
| 10:21:18 | ponger reports to lead: "Received PING, sent PONG." |
| 10:21:19 | pinger reports to lead: "Sent PING, received PONG." |
| 10:21:21 | Both agents go idle |

**Observations**:
- **Team name was auto-generated** (`swirling-enchanting-wilkes`), not "ping-pong" as requested. `TeamCreate` generates a random slug regardless of user intent.
- All agents ran as **opus-4-6** (the default model) and **in-process**.
- **No shutdown occurred** — the `-p` session terminated before the lead could send shutdown requests, leaving orphaned team/task files on disk.
- **Missing inbox file** — `pinger.json` was never created under `inboxes/`, though pinger did receive ponger's reply. In-process delivery may bypass the inbox file in some cases.

### Interactive session

Same prompt, run inside a normal `claude` interactive session.

**Result**: Also completed successfully. Same exchange pattern (PING! / PONG!), both agents reported back to lead.

**Differences from `-p`**:
- Used **haiku** model for agents (explicitly specified) — cheaper and faster.
- All 3 inbox files were created (`pinger.json`, `ponger.json`, `team-lead.json`).
- Team name was also auto-generated (`peaceful-brewing-tide`).
- Shutdown was also not completed (lead hadn't processed reports yet at time of inspection).

### Key takeaways

1. **Teams work in `-p` mode** — the full lifecycle (create team, spawn agents, message exchange, report) completes even in non-interactive mode.
2. **Cleanup is not automatic** — neither mode cleans up team/task files. Orphaned files accumulate at `~/.claude/teams/` and `~/.claude/tasks/`.
3. **Team names are always auto-generated** — the `team_name` parameter to `TeamCreate` does not control the actual name; a random three-word slug is generated.
4. **In-process inbox persistence is inconsistent** — some agent inbox files may not be created when delivery happens in-process. Don't rely on inbox files for complete message audit trails.

---

## 11. Observability via Claude Code Remote Control

[Remote Control](https://code.claude.com/docs/en/remote-control) is an official Anthropic feature (launched v2.1.51, Feb 25 2026). It lets you observe and interact with a local Claude Code session from your phone, tablet, or any browser via `claude.ai/code` or the Claude mobile app.

**How it works:** Run `claude remote-control` or `/rc` inside a session to get a QR code / URL. The local session makes outbound HTTPS requests only (no inbound ports opened) — it registers with the Anthropic API and polls for work. The server routes messages between the remote client and local session over a streaming connection, all over TLS. Requires Pro or Max subscription.

**Behavior with multi-agent teams:**

- **You can see what the team lead is doing** — tool calls, messages received from agents, decisions being made. This is the primary value.
- **You cannot switch between agents** — there's no way to select a specific teammate's session to observe. Only the lead's session is visible.
- **This is fine in practice** — as we move up levels of abstraction, digging into what individual agents did doesn't make sense. You can just ask the lead. The lead receives all reports and idle notifications, so it has the full picture.
- **Topology matters for performance, not visibility** — the team breakdown (how many agents, what roles, task dependencies) affects task execution quality. Visibility into individual agents is a bonus, not a requirement. The lead is the abstraction boundary.

**For Happy:**

We don't need to intercept Remote Control or support viewing individual agent sessions (we don't for regular subagents either). What would be cool:

1. **Force-enable agent teams** — set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` from Happy so users get multi-agent capabilities without manual setup.
2. **Show sub-agents in the UI** — read `~/.claude/teams/{team-name}/config.json` to discover team members. Display who's active, their colors, idle/working status. The data is all on disk already (inboxes track messages, idle notifications come through the lead's inbox).
3. **Don't need to support viewing sub-agent sessions** — just show the team topology and activity indicators. The lead's session is the only one that matters for interaction.

This is a lightweight UI feature with high visual impact — agent swarm activity showing up in the Happy sidebar would trend on Twitter.

---

## 12. Agent Teams Stability & Known Issues (not worth integrating now)

Researched Feb 26 2026 across GitHub issues, official docs, Twitter, and our own tests.

### The problem

Agent teams are hard to control remotely — even the lead gets stuck. The [official docs](https://code.claude.com/docs/en/agent-teams) don't mention `-p` / headless / SDK usage with teams at all. Teams are designed for interactive sessions where a human can steer.

Even Anthropic's own app (claude.ai/code via Remote Control) only renders shitty tool calls for team activity — there's no real team UI, just the lead's raw tool call stream. If Anthropic hasn't built proper team observability into their own product yet, it's too early for us.

### Why teams get stuck

| Issue | Description | GitHub |
|-------|-------------|--------|
| **Permission stalls** | Without pre-approved permissions, teammates block on prompts with nobody to approve. #1 cause of stuck teams. | — |
| **Lead exits early** | In `-p` mode, lead terminates after its response. Agents orphaned. We confirmed this in our ping-pong test. | — |
| **Indefinite hangs** | Agent stops producing output mid-task, no timeout, no recovery. Only fix is pressing Esc (impossible headless). | [#28482](https://github.com/anthropics/claude-code/issues/28482) |
| **Incomplete shutdown** | Orchestrator says "team terminated" but some instances keep running, causing infinite loops. | [#28552](https://github.com/anthropics/claude-code/issues/28552) |
| **Tmux mailbox never polled** | In tmux mode, agents stuck at idle because mailbox polling only activates between turns. | [#24108](https://github.com/anthropics/claude-code/issues/24108) |
| **Message delivery failures** | In VS Code, teammate messages not delivered to lead; permission prompts invisible, causing deadlock. | [#25254](https://github.com/anthropics/claude-code/issues/25254) |

### Workarounds (all interactive-only)

- `--dangerously-skip-permissions` to eliminate permission stalls
- Pre-configure permission allowlists in `settings.json`
- Tell the lead "wait for your teammates to complete before proceeding"
- Shift+Down to manually nudge stuck agents

None of these work for programmatic / remote control.

### Twitter signal

Mostly noise — RT spam about Pencil (design tool) using Agent Teams, generic "agent teams are cool" posts, one reply suggesting `--dangerously-skip-permissions`. Nobody discussing programmatic/headless team orchestration or building products on top of it.

### Decision: not worth integrating now

- **Hard to control from remote** — even the lead hangs with no recovery path in headless mode
- **Anthropic's own app doesn't do it well** — claude.ai/code just shows raw tool calls for team activity, no proper team UI
- **Feature is experimental** — still behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` flag, major open bugs, no SDK support
- **Subagents (Task tool) work fine** — for programmatic use, regular subagents are reliable and don't need the team coordination layer
- **Revisit when**: Anthropic ships proper SDK support for teams, or stabilizes the feature out of experimental

---

## Sources

- On-disk exploration of `~/.claude/` (live ping-pong team session)
- Official docs: https://code.claude.com/docs/en/agent-teams
- Binary reverse-engineering: https://paddo.dev/blog/claude-code-hidden-swarm/
- Architecture deep-dive: https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/
- OpenCode port: https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol
- Addy Osmani overview: https://addyosmani.com/blog/claude-code-agent-teams/
