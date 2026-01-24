# Arc Architecture

Technical deep-dive into how Arc works.

## Core Principle

**Agents live in repositories, not in the mobile app.**

The mobile app is a *viewing layer* that connects to running agents, not a container for AI logic.

## Repository Structure

Arc is a fork of Happy with isolated customizations:

```
arc/                              # Fork of slopus/happy
├── cli/                          # Happy CLI (unmodified)
├── expo-app/                     # Mobile app
│   ├── sources/
│   │   ├── arc/                  # ← ALL ARC CODE
│   │   │   ├── agent/            # .arc.yaml loading
│   │   │   │   ├── types.ts      # Config schema (Zod)
│   │   │   │   ├── context.tsx   # React context provider
│   │   │   │   ├── useAgentConfig.ts
│   │   │   │   └── index.ts
│   │   │   ├── voice/            # Voice binding
│   │   │   └── ui/               # Custom components
│   │   ├── components/           # Happy (unmodified)
│   │   ├── realtime/             # Happy (unmodified)
│   │   └── ...
│   ├── app/                      # Expo Router (patch minimally)
│   └── ...
├── server/                       # Happy relay (unmodified)
└── docs/                         # Arc documentation
```

**Rule:** Never modify Happy's existing files. All Arc code goes in `sources/arc/`. If we must change Happy code, use `patch-package`.

## System Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         User's Machine                          │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Agent Repository (e.g., ~/src/emila)                      │ │
│  │  ├── AGENTS.md        ← Behavior definition                │ │
│  │  ├── .arc.yaml        ← Display config                     │ │
│  │  └── memory-bank/     ← Agent memory                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Claude Code Daemon                                        │ │
│  │  ├── RPC Server        ← readFile handler                  │ │
│  │  └── Socket Tunnel     ← Encrypted to relay                │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                               │
                    WebSocket (encrypted)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Happy Relay                              │
│  ├── Session Registry                                           │
│  └── Message Routing                                            │
└─────────────────────────────────────────────────────────────────┘
                               │
                    WebSocket (encrypted)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Arc Mobile App                             │
│  ├── Session List                                               │
│  ├── sources/arc/agent/   ← Loads .arc.yaml per session        │
│  ├── sources/arc/voice/   ← Binds ElevenLabs agent             │
│  └── Message UI                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Agent Config Loading

When displaying a session:

```
1. Session connects
   └── Mobile receives metadata from relay (path, summary)

2. Mobile attempts RPC
   └── sessionRPC(sessionId, 'readFile', { path: '.arc.yaml' })
   └── 3 second timeout

3a. Success
    └── Parse YAML → Display name, avatar, voice binding

3b. Timeout/Error
    └── Fall back to path-based name, generated avatar
```

## .arc.yaml Schema

```yaml
agent:
  name: "Emila"                    # Display name
  tagline: "Executive assistant"   # Short description
  avatar: generated                # "generated" or URL
  primaryColor: "#6366F1"          # Accent color

voice:
  elevenlabs_agent_id: "abc123"    # Conversational Agent ID
  greeting: "Hey, what's up?"      # Custom greeting
  language: "en"                   # Language code

org:                               # Future: enterprise
  id: "runline"
  require_auth: false
```

## Integration Points

Arc integrates with Happy at these points:

| Integration | Location | Method |
|-------------|----------|--------|
| Agent config provider | `app/_layout.tsx` | Wrap with `<ArcAgentConfigProvider>` |
| Session display name | `utils/sessionUtils.ts` | Patch `getSessionName()` |
| Voice binding | `realtime/` | Import from `@/arc/voice` |

All integration uses imports from `@/arc/*` - no modifications to Happy source.

## Import Pattern

From any Happy file:
```typescript
// Import Arc modules
import { useSessionAgentConfig } from '@/arc/agent';
import { ArcVoiceProvider } from '@/arc/voice';
```

Metro bundler resolves `@/` to `expo-app/sources/`, so `@/arc/` → `sources/arc/`.

## Caching

Agent configs cached in-memory:
- 5 minute TTL
- Keyed by sessionId
- Invalidated on disconnect
- Refreshed on explicit reload

## Merging Upstream

Since Arc is a fork:

```bash
git remote add upstream https://github.com/slopus/happy.git
git fetch upstream
git merge upstream/main
```

Conflicts should be minimal because:
- All Arc code is in `sources/arc/` (new directory)
- Happy files are unmodified (or use patch-package)

## Future: Enterprise

```yaml
org:
  id: "cu-answers"
  require_auth: true
  sso_provider: "okta"
```

- Organization-scoped session visibility
- SSO authentication
- Audit logging
