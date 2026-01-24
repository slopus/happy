# Arc Setup Guide

## Prerequisites

- Node.js 18+
- Yarn 1.22+
- Xcode 15+ (iOS)
- Claude Code installed
- ElevenLabs account (optional, for voice)

## Initial Setup

### 1. Fork Happy

Arc is a fork of Happy. Start by forking:

```bash
# Fork slopus/happy on GitHub, then:
git clone https://github.com/[your-org]/arc.git ~/src/runline/arc
cd ~/src/runline/arc

# Add upstream for future syncing
git remote add upstream https://github.com/slopus/happy.git
```

### 2. Create Arc Directory

Create the Arc customization directory:

```bash
mkdir -p expo-app/sources/arc/{agent,voice,ui}
```

### 3. Install Dependencies

```bash
yarn install
```

### 4. Run Development

```bash
cd expo-app
yarn ios
```

## Project Structure

```
arc/
├── cli/                      # Happy CLI (don't modify)
├── expo-app/
│   ├── sources/
│   │   ├── arc/              # ← Your code goes here
│   │   │   ├── agent/        # .arc.yaml loading
│   │   │   ├── voice/        # Voice binding
│   │   │   └── ui/           # Custom components
│   │   └── ...               # Happy sources (don't modify)
│   ├── app/                  # Expo Router
│   └── package.json
├── server/                   # Happy relay (don't modify)
└── docs/                     # Arc docs
```

## Setting Up an Agent

### 1. Create .arc.yaml

In your agent repository (e.g., `~/src/emila`):

```yaml
# .arc.yaml
agent:
  name: "Emila"
  tagline: "Executive assistant"
  avatar: generated

voice:
  elevenlabs_agent_id: ""  # Add after creating voice agent
```

### 2. Create Voice Agent (Optional)

1. Go to [ElevenLabs Conversational AI](https://elevenlabs.io/conversational-ai)
2. Create agent matching your agent's personality
3. Copy agent ID to `.arc.yaml`

### 3. Start Agent

```bash
cd ~/src/emila
claude-code  # or: happy --yolo
```

Agent appears in Arc mobile with custom name/avatar.

## Syncing Upstream

Periodically pull Happy updates:

```bash
git fetch upstream
git merge upstream/main
```

Conflicts should be rare since Arc code is isolated in `sources/arc/`.

## Integration Patches

If you need to modify Happy files, use patch-package:

```bash
# After modifying a Happy file
npx patch-package [package-name]
```

Patches are stored in `expo-app/patches/` and auto-applied on install.

## Development Tips

### Import Arc Modules

```typescript
// From any file in expo-app
import { useSessionAgentConfig } from '@/arc/agent';
```

### Adding New Arc Features

1. Create files in `expo-app/sources/arc/`
2. Export from appropriate index.ts
3. Import using `@/arc/...` path

### Testing Agent Config

1. Start Claude Code in a repo with `.arc.yaml`
2. Connect Arc mobile to same account
3. Verify agent name/avatar appear correctly

## Troubleshooting

### Agent name not showing
- Check `.arc.yaml` exists and is valid YAML
- Agent must be online (Claude Code running)
- RPC has 3s timeout, then falls back to defaults

### Merge conflicts
- We shouldn't have conflicts if only `sources/arc/` is modified
- If you modified Happy files, consider using patch-package instead

### Build errors after upstream merge
- Run `yarn install`
- Check patches still apply
- Review Happy changelog for breaking changes
