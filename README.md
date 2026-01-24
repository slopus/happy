# Runline

**Agent Runner Command** — Runline's secured agentic runtime.

Runline is a fork of [Happy](https://github.com/slopus/happy) that provides a mobile interface for AI agents running on Claude Code. The app is a **window into agents that live in repositories**.

While largely dependent on core Happy functionality, Runline extends the platform with enterprise-focused features:
- **Agents** — Repository-defined agent identity via `.arc.yaml`
- **Organization structure** — Team and enterprise agent management
- **SOPs** — Standard operating procedures for agent workflows
- **Platform-aware capabilities** — Features beyond Happy's scope

> **Note:** Arc is built on Happy's excellent open-source foundation. See [Happy's documentation](https://happy.engineering/docs/) for base functionality.

## Philosophy

```
Agent identity lives in the repo, not the app.
```

Every agent repository contains:
- `AGENTS.md` / `CLAUDE.md` — Defines behavior, personality, capabilities
- `.arc.yaml` — Display metadata (name, avatar, voice binding)

The mobile app:
- Connects to running Claude Code sessions
- Reads `.arc.yaml` via RPC to customize display
- Binds voice agents (ElevenLabs) per session

## What Arc Adds

| Feature | Happy | Arc |
|---------|-------|-----|
| Agent display name | Path-based | From `.arc.yaml` |
| Agent avatar | Generated | Configurable |
| Voice binding | Single agent | Per-session |
| Enterprise auth | — | Planned |

## .arc.yaml

Agents configure their display via `.arc.yaml` in their repo:

```yaml
agent:
  name: "Emila"
  tagline: "Executive assistant"
  avatar: generated

voice:
  elevenlabs_agent_id: "agent-id-here"
```

## Repository Structure

Arc customizations are isolated in `expo-app/sources/arc/`:

```
arc/
├── cli/                      # Happy CLI (unmodified)
├── expo-app/
│   ├── sources/
│   │   ├── arc/              # ← ALL ARC CUSTOMIZATION
│   │   │   ├── agent/        # .arc.yaml loading
│   │   │   ├── voice/        # Voice binding
│   │   │   └── ui/           # Custom components
│   │   └── ...               # Happy sources (unmodified)
│   └── ...
├── server/                   # Happy relay (unmodified)
└── docs/                     # Arc documentation
```

**Key principle:** Minimize modifications to Happy files. Use `sources/arc/` for customization.

## Quick Start

```bash
# Clone
git clone https://github.com/Runline-AI/arc.git
cd arc

# Install
yarn install

# Run iOS
cd expo-app
yarn ios
```

## Syncing Upstream

Pull Happy updates:

```bash
git fetch upstream
git merge upstream/main
```

## Documentation

- [SETUP.md](./SETUP.md) — Development setup
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — Technical deep-dive
- [docs/AGENTS.md](./docs/AGENTS.md) — How agents work

## Credits

Arc is built on [Happy](https://github.com/slopus/happy) by the Happy Engineering team. Thank you for the open-source foundation.

## License

Apache 2.0 — See [LICENSE](./LICENSE) and [NOTICE](./NOTICE)
