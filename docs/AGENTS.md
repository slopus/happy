# Agents in Runline Arc

How AI agents work in the Runline Arc ecosystem.

## What is an Agent?

In Runline Arc, an agent is a Claude Code session running in a specific repository. The agent's identity, behavior, and personality are defined by the repository itself — not by the mobile app.

```
Agent = Repository + Claude Code Session
```

## Agent Identity Stack

Each agent has three layers of identity:

### 1. Behavior (AGENTS.md / CLAUDE.md)

The repository's `AGENTS.md` or `CLAUDE.md` file defines:
- How the agent should behave
- What personality traits it exhibits
- What it should and shouldn't do
- Domain expertise and knowledge

This is the **soul** of the agent.

Example from Emila's repo:
```markdown
# AGENTS.md

You are Emila, Sean Hsieh's executive assistant.

## Personality
- Proactive but not intrusive
- Professional with warmth
- Anticipates needs based on context

## Capabilities
- Calendar and schedule management
- Communication drafting
- Research and synthesis
- Task tracking and reminders

## Boundaries
- Never make commitments on Sean's behalf
- Always confirm before sending external communications
```

### 2. Display (`.arc.yaml`)

The `.arc.yaml` file defines how the agent appears in Runline mobile:

```yaml
agent:
  name: "Emila"
  tagline: "Executive assistant"
  avatar: generated

voice:
  elevenlabs_agent_id: "agent-abc123"
```

This is read by the mobile app via RPC when connecting to a session.

### 3. Memory (memory-bank/)

The agent's accumulated context and learnings:

```
memory-bank/
├── profile/
│   ├── working-set.md    # Current working context
│   └── preferences.md    # Learned preferences
├── decisions/            # Decision log
└── relationships/        # Relationship context
```

## Creating an Agent

To create a new agent:

### 1. Create Repository

```bash
mkdir ~/src/my-agent
cd ~/src/my-agent
git init
```

### 2. Define Behavior

Create `AGENTS.md`:
```markdown
# AGENTS.md

You are [Agent Name], a [role description].

## Personality
- [Trait 1]
- [Trait 2]

## Capabilities
- [What this agent can do]

## Boundaries
- [What this agent should not do]
```

### 3. Add Arc Config

Create `.arc.yaml`:
```yaml
agent:
  name: "My Agent"
  tagline: "Short description"
  avatar: generated

voice:
  elevenlabs_agent_id: ""  # Optional: add voice agent ID
```

### 4. Initialize Memory (Optional)

```bash
mkdir -p memory-bank/profile
echo "# Working Set" > memory-bank/profile/working-set.md
```

### 5. Start the Agent

```bash
claude-code
# or
happy --yolo
```

The agent is now running and will appear in Runline mobile.

## Agent Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│                     AGENT LIFECYCLE                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Repository Created                                       │
│     └── AGENTS.md defines initial behavior                   │
│                                                              │
│  2. Session Started                                          │
│     └── Claude Code reads AGENTS.md                          │
│     └── Agent persona activates                              │
│                                                              │
│  3. Mobile Connects                                          │
│     └── Arc reads .arc.yaml via RPC                          │
│     └── Display customized for agent                         │
│     └── Voice agent bound (if configured)                    │
│                                                              │
│  4. Interaction                                              │
│     └── User communicates via text/voice                     │
│     └── Agent responds per AGENTS.md behavior                │
│     └── Memory accumulates in memory-bank/                   │
│                                                              │
│  5. Session Ends                                             │
│     └── Memory persists in repo                              │
│     └── Next session continues context                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Voice Agents

For voice interaction, agents can be paired with ElevenLabs Conversational Agents:

1. Create voice agent at [ElevenLabs](https://elevenlabs.io/conversational-ai)
2. Configure personality to match AGENTS.md
3. Add agent ID to `.arc.yaml`:

```yaml
voice:
  elevenlabs_agent_id: "your-agent-id"
```

When the user taps the microphone in Runline, the ElevenLabs agent handles voice interaction, with personality aligned to the repo's agent definition.

## Multi-Agent Setup

A user can have multiple agents, each in their own repository:

```
~/src/
├── emila/          # Executive assistant
├── deal-analyst/   # Investment analysis agent
├── content-bot/    # Content creation agent
└── debug-helper/   # Coding assistant
```

Each appears as a separate session in Runline mobile, with its own identity and voice.

## Enterprise Agents

For organizations, agents can be bound to an org:

```yaml
# .arc.yaml
org:
  id: "acme-corp"
  require_auth: true
```

This enables:
- Visibility to authorized org members
- SSO authentication requirement
- Centralized management
- Audit logging

## Best Practices

### Behavior Definition
- Be specific in AGENTS.md about personality
- Define clear boundaries
- Include example interactions
- Document domain expertise

### Voice Alignment
- Match ElevenLabs agent personality to AGENTS.md
- Use consistent greeting style
- Configure language appropriately

### Memory Management
- Regularly review working-set.md
- Prune stale context
- Keep decisions/ log current
- Archive completed projects

## Comparison: Runline Arc vs Traditional AI Apps

| Aspect | Traditional AI App | Runline Arc |
|--------|-------------------|-------------|
| Agent definition | In app code | In repository |
| Personality | Static per app | Per repo (AGENTS.md) |
| Memory | Cloud storage | Local (memory-bank/) |
| Voice | One voice | Per agent |
| Updates | App update needed | Edit AGENTS.md |
| Portability | Locked to app | Git-based, portable |

Runline Arc's approach means:
- Agents evolve with their repositories
- No vendor lock-in
- Full control over agent behavior
- Privacy preserved (local memory)
