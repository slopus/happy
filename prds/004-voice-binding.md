# PRD-004: Per-Session Voice Binding

**Type:** Ralph-friendly (mechanical integration)
**Complexity:** Medium
**Estimated iterations:** 4-6

## Goal

Bind ElevenLabs voice agents per-session based on `.arc.yaml` configuration.

## Background

Currently Happy uses a single ElevenLabs agent for all sessions. Arc should read `voice.elevenlabs_agent_id` from `.arc.yaml` and use session-specific voice agents.

## Success Criteria (Programmatic)

1. `yarn tsc --noEmit` passes
2. App launches without crash
3. When opening a session with `.arc.yaml` containing `voice.elevenlabs_agent_id`, that agent ID is used for voice

## Current State

- `.arc.yaml` schema includes `voice.elevenlabs_agent_id` field
- `getVoiceId(sessionId)` method exists in AgentConfigContext
- ElevenLabs integration exists in `sources/realtime/`
- Voice is initialized somewhere in the realtime provider

## Implementation Steps

### Step 1: Find voice initialization

Search for ElevenLabs initialization:
```bash
grep -rn "elevenlabs\|ElevenLabs\|agentId" sources/realtime/ --include="*.ts" --include="*.tsx"
```

### Step 2: Identify where agent ID is set

Find where the current (hardcoded or config-based) agent ID is passed to ElevenLabs.

### Step 3: Import agent config

In the voice initialization component:

```typescript
import { useAgentConfigContext } from '@/arc/agent';
```

### Step 4: Use session-specific agent ID

```typescript
const { getVoiceId, loadConfig } = useAgentConfigContext();

// When session is selected for voice
const voiceAgentId = getVoiceId(sessionId);

// Use voiceAgentId if available, otherwise fall back to default
const agentId = voiceAgentId || DEFAULT_AGENT_ID;
```

### Step 5: Trigger config load

Ensure `.arc.yaml` is loaded before voice initialization:

```typescript
useEffect(() => {
  if (sessionId) {
    loadConfig(sessionId);
  }
}, [sessionId]);
```

### Step 6: Verify

- Run `yarn tsc --noEmit`
- Run app and test voice with a session that has `.arc.yaml`

## Files to Modify

- `sources/realtime/VoiceProvider.tsx` (or similar)
- Possibly `sources/realtime/useVoice.ts`

## Files to NOT Modify

- `sources/arc/agent/*` - already complete

## Verification Commands

```bash
cd ~/src/runline/arc/expo-app
yarn tsc --noEmit
```

## Testing Notes

To test properly:
1. Create `.arc.yaml` in a repo with `voice.elevenlabs_agent_id: "your-agent-id"`
2. Start Claude Code in that repo
3. Connect Arc mobile
4. Start voice - should use the specified agent

## Rollback

Revert changes to realtime provider. Voice will use default agent.
