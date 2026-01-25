# PRD-001: Runner Display Name Integration

**Type:** Ralph-friendly (mechanical code change)
**Complexity:** Low
**Estimated iterations:** 2-3

## Goal

Make the session list display Runner names from `.arc.yaml` instead of path-based names.

**Note:** Runners are purpose-built agents with Runline-hosted capabilities. The code uses `agent` naming for backwards compatibility.

## Success Criteria (Programmatic)

1. TypeScript compiles without errors: `yarn tsc --noEmit`
2. App launches without crash: `yarn ios` shows session list
3. When a session has `.arc.yaml` with `agent.name: "Emila"`, the session list shows "Emila" (Runner name) instead of the path

## Current State

- `AgentConfigProvider` exists at `sources/arc/agent/context.tsx`
- Provider is wired into `_layout.tsx`
- `getDisplayName(sessionId, fallback)` method available for Runner names
- Session list currently uses `getSessionName()` from `utils/sessionUtils.ts`

## Implementation Steps

### Step 1: Find session list component

Search for where sessions are rendered in a list. Look for:
- Components importing `getSessionName`
- Components rendering session metadata
- Files in `sources/components/` related to sessions

### Step 2: Import agent config hook

In the session list item component:

```typescript
import { useAgentConfigContext } from '@/arc/agent';
```

### Step 3: Use Runner display name

Replace or augment the existing name display:

```typescript
const { getDisplayName, loadConfig } = useAgentConfigContext();

// Trigger config load when session becomes visible
useEffect(() => {
  loadConfig(session.id);
}, [session.id]);

// Get display name with path-based fallback
const displayName = getDisplayName(session.id, getSessionName(session));
```

### Step 4: Verify

- Run `yarn tsc --noEmit` - should pass
- Run `yarn ios` - app should launch
- Connect to a session with `.arc.yaml` - should show Runner name

## Files to Modify

- `expo-app/sources/components/SessionListItem.tsx` (or similar)
- Possibly `expo-app/sources/utils/sessionUtils.ts`

## Files to NOT Modify

- `expo-app/sources/arc/agent/*` - already complete
- `expo-app/sources/app/_layout.tsx` - already has provider

## Verification Commands

```bash
cd ~/src/runline/arc/expo-app
yarn tsc --noEmit
```

## Rollback

If broken, revert changes to the session list component only.
