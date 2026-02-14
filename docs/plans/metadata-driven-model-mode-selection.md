# Metadata-Driven Model and Mode Selection on Client

## Overview
- Make the client use backend-provided metadata fields (`metadata.models[]`, `metadata.operatingModes[]`, `metadata.currentModelCode`, `metadata.currentOperatingModeCode`) for model and mode selection in active sessions, instead of hardcoding options per agent type
- Principle: if metadata provides options, use them; otherwise fall back to hardcoded defaults
- Models: always prefer metadata when available (all agent types)
- Modes: hardcoded for claude/codex, metadata-driven for others when available
- Send model selection via message meta for all agent types (not just Gemini)
- Both `ModelMode` and `PermissionMode` become structured types `{ key: string; name: string; description?: string | null }` — UI shows `name` everywhere, `key` is the value sent to backend/stored

## Context (from discovery)
- Backend already emits `config_options_update`, `modes_update`, `models_update` events and populates `metadata.models[]`, `metadata.operatingModes[]`, `metadata.currentModelCode`, `metadata.currentOperatingModeCode`
- Metadata shape: `{ code: string; value: string; description?: string | null }` — maps as `{ key: code, name: value, description }`
- Frontend currently hardcodes: Claude (sonnet/opus), Codex (gpt-5-*), Gemini (gemini-2.5-*)
- `ModelMode` type is currently a flat string union
- `PermissionMode` type is currently a flat string union (`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo'`)
- `Session.modelMode` is restricted to `'default' | 'gemini-2.5-pro' | 'gemini-2.5-flash' | 'gemini-2.5-flash-lite'`
- `Session.permissionMode` is restricted to the `PermissionMode` string union
- `updateSessionModelMode()` and `updateSessionPermissionMode()` in storage only accept those specific strings
- `sendMessage()` only sends model in meta for Gemini sessions
- Both mode and model selectors are hardcoded per agent type in AgentInput.tsx

## Files involved
| File | Change |
|------|--------|
| `packages/happy-app/sources/components/PermissionModeSelector.tsx` | Change both `ModelMode` and `PermissionMode` to `{ key, name, description }` struct |
| `packages/happy-app/sources/sync/storageTypes.ts` | Change `Session.modelMode` and `Session.permissionMode` to `string | null` (store key only) |
| `packages/happy-app/sources/sync/storage.ts` | Widen both `updateSessionModelMode()` and `updateSessionPermissionMode()` to accept `string` |
| `packages/happy-app/sources/components/AgentInput.tsx` | Accept structs for both, render from metadata or hardcoded, show `name` in UI |
| `packages/happy-app/sources/-session/SessionView.tsx` | Build structs from metadata for both model and mode, pass to AgentInput |
| `packages/happy-app/sources/sync/sync.ts` | Send model key in meta for all agent types, send permission mode key |
| `packages/happy-app/sources/sync/typesMessageMeta.ts` | Ensure meta schema accepts any string for permissionMode |
| `packages/happy-app/sources/app/(app)/new/index.tsx` | Adapt to structs for both model and mode |

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Run tests after each change
- Maintain backward compatibility

## Testing Strategy
- **Unit tests**: required for every task (see Development Approach above)

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done
- ⚠️ `yarn workspace happy-app lint` is unavailable because the package has no `lint` script

## Implementation Steps

### Task 1: Change ModelMode and PermissionMode types to structs
- [x] Change `ModelMode` type in `PermissionModeSelector.tsx` from flat string union to `{ key: string; name: string; description?: string | null }`
- [x] Change `PermissionMode` type in `PermissionModeSelector.tsx` from flat string union to `{ key: string; name: string; description?: string | null }`
- [x] Change `Session.modelMode` in `storageTypes.ts` from hardcoded union to `string | null` (stores key only)
- [x] Change `Session.permissionMode` in `storageTypes.ts` from hardcoded union to `string | null` (stores key only)
- [x] Change `updateSessionModelMode()` in `storage.ts` to accept `string`
- [x] Change `updateSessionPermissionMode()` in `storage.ts` to accept `string`
- [x] Update `permissionMode` in `MessageMetaSchema` in `typesMessageMeta.ts` from enum to `z.string()` (keys are now arbitrary strings)
- [x] Fix TypeScript compilation errors from type changes across the codebase
- [x] Run tests - must pass before next task

### Task 2: Build hardcoded PermissionMode and ModelMode struct lists
- [x] Create helper constants for hardcoded Claude permission modes as struct arrays: `[{ key: 'default', name: 'Default' }, { key: 'acceptEdits', name: 'Accept Edits' }, ...]`
- [x] Create helper constants for hardcoded Codex/Gemini permission modes as struct arrays: `[{ key: 'default', name: 'Default' }, { key: 'read-only', name: 'Read Only' }, ...]`
- [x] Create helper constants for hardcoded model modes per agent type (Claude: sonnet/opus, Codex: gpt-5-*, Gemini: gemini-2.5-*)
- [x] Mode `name` is simply the `key` capitalized (e.g. `"plan"` → `"Plan"`, `"build"` → `"Build"`) — no translation keys needed for mode names
- [x] Write tests for struct constants having correct keys and names
- [x] Run tests - must pass before next task

### Task 3: Update SessionView to build structs from metadata
- [x] Build `ModelMode` struct for current model: look up `session.modelMode` key in `metadata.models[]`, fall back to `metadata.currentModelCode`, or null
- [x] Build `PermissionMode` struct for current mode: look up `session.permissionMode` key in `metadata.operatingModes[]` (for non-claude/codex) or hardcoded list (for claude/codex)
- [x] Build `availableModels` list: use `metadata.models[]` if non-empty, else hardcoded fallback for known agents
- [x] Build `availableModes` list: use hardcoded for claude/codex, use `metadata.operatingModes[]` for others if non-empty
- [x] Update `updateModelMode` callback: extract `key` from struct, call `updateSessionModelMode(key)`
- [x] Update `updatePermissionMode` callback: extract `key` from struct, call `updateSessionPermissionMode(key)`
- [x] Pass structs and available lists to `AgentInput`
- [x] Write tests for struct construction from metadata
- [x] Write tests for fallback when metadata is empty
- [x] Run tests - must pass before next task

### Task 4: Update AgentInput to render from structs
- [x] Update props: `modelMode` → `ModelMode | null`, `permissionMode` → `PermissionMode | null`
- [x] Add `availableModels` and `availableModes` props (arrays of structs)
- [x] In model section: render from `availableModels`, show `name` as label, `description` as subtitle, compare by `key`
- [x] In mode section: render from `availableModes`, show `name` as label, compare by `key`
- [x] On model selection: call `onModelModeChange(struct)` with full struct
- [x] On mode selection: call `onPermissionModeChange(struct)` with full struct
- [x] Update status bar: show `modelMode.name` and `permissionMode.name` instead of hardcoded label lookups
- [x] Update keyboard shortcut (Shift+Tab) to cycle through `availableModes` structs
- [x] Write tests for rendering from struct arrays
- [x] Write tests for selection callbacks passing full structs
- [x] Run tests - must pass before next task

### Task 5: Send model and mode keys in message meta for all agent types
- [x] In `sync.ts` `sendMessage()`, read `session.modelMode` (key string) and send in `meta.model` when set and not `'default'` — for ALL agent types, not just Gemini
- [x] Read `session.permissionMode` (key string) and send in `meta.permissionMode`
- [x] Remove Gemini-specific model logic and hardcoded default fallbacks
- [x] Write tests for sendMessage including model key for non-Gemini agents
- [x] Write tests for sendMessage sending permission mode key
- [x] Run tests - must pass before next task

### Task 6: Update new session wizard
- [x] Update `modelMode` state to `ModelMode | null` struct
- [x] Update `permissionMode` state to `PermissionMode` struct
- [x] Build structs from hardcoded defaults per agent type (metadata not available at creation time)
- [x] On session creation, call `updateSessionModelMode(modelMode.key)` and `updateSessionPermissionMode(permissionMode.key)`
- [x] Update `lastUsedModelMode` / `lastUsedPermissionMode` settings to store/restore keys
- [x] Write tests for struct construction in wizard
- [x] Run tests - must pass before next task

### Task 7: Verify acceptance criteria
- [x] Verify model selector shows `name` from metadata when metadata.models is populated
- [x] Verify model selector falls back to hardcoded names when metadata is empty
- [x] Verify mode selector shows `name` from metadata for non-claude/codex agents
- [x] Verify mode selector shows hardcoded names for claude/codex
- [x] Verify model `key` (not name) is sent in meta.model for all agent types
- [x] Verify permission mode `key` (not name) is sent in meta.permissionMode
- [x] Verify `name` is shown in status bar, selectors, and badges — never raw `key`
- [x] Run full test suite (unit tests)
- [ ] Run linter - all issues must be fixed

### Task 8: [Final] Update documentation
- [x] Update README.md if needed
- [x] Update project knowledge docs if new patterns discovered

## Technical Details

### Shared struct type for both Model and Mode

```typescript
// Both ModelMode and PermissionMode use the same shape
type ModelMode = {
  key: string;                      // Technical ID sent to backend (e.g. "gemini-2.5-pro")
  name: string;                     // Display name shown in UI (e.g. "Gemini 2.5 Pro")
  description?: string | null;      // Optional subtitle (e.g. "Most capable")
};

type PermissionMode = {
  key: string;                      // Technical ID sent to backend (e.g. "plan", "build")
  name: string;                     // Display name = key capitalized (e.g. "Plan", "Build")
  description?: string | null;      // Optional subtitle
};
```

### Mapping from metadata

```typescript
// metadata.models[] → ModelMode[]
metadata.models.map(m => ({
  key: m.code,
  name: m.value,
  description: m.description
}))

// metadata.operatingModes[] → PermissionMode[]
metadata.operatingModes.map(m => ({
  key: m.code,
  name: m.value,
  description: m.description
}))
```

### Hardcoded fallbacks (examples)

```typescript
// Claude permission modes — name is just key capitalized
const CLAUDE_PERMISSION_MODES: PermissionMode[] = [
  { key: 'default', name: 'Default' },
  { key: 'acceptEdits', name: 'Accept Edits' },
  { key: 'plan', name: 'Plan' },
  { key: 'bypassPermissions', name: 'Bypass Permissions' },
];

// Gemini models (fallback when metadata not available)
const GEMINI_MODELS: ModelMode[] = [
  { key: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable' },
  { key: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast & efficient' },
  { key: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', description: 'Fastest' },
];
```

### Storage: stores key only

```typescript
// storageTypes.ts
Session.modelMode?: string | null;       // Key only (e.g. "gemini-2.5-pro")
Session.permissionMode?: string | null;  // Key only (e.g. "acceptEdits")

// storage.ts
updateSessionModelMode(sessionId: string, key: string)
updateSessionPermissionMode(sessionId: string, key: string)
```

### Data flow (after changes)

```
Backend emits metadata:
  metadata.models = [{ code: "gemini-2.5-pro", value: "Gemini 2.5 Pro", description: "Most capable" }, ...]
  metadata.currentModelCode = "gemini-2.5-pro"
  metadata.operatingModes = [{ code: "default", value: "Default" }, ...]
  metadata.currentOperatingModeCode = "default"

SessionView builds structs:
  modelMode = { key: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Most capable" }
  permissionMode = { key: "default", name: "Default", description: null }
  availableModels = metadata.models → ModelMode[]
  availableModes = hardcoded (claude/codex) OR metadata.operatingModes → PermissionMode[]

AgentInput renders:
  Shows "Gemini 2.5 Pro" (name) in model selector and status bar
  Shows "Default" (name) in mode selector and status bar
  On selection → calls onChange with full { key, name, description } struct

SessionView handles change:
  Extracts key → calls updateSessionModelMode("gemini-2.5-pro")
  Extracts key → calls updateSessionPermissionMode("acceptEdits")

sendMessage():
  Reads session.modelMode ("gemini-2.5-pro") → sends as meta.model (ALL agents)
  Reads session.permissionMode ("acceptEdits") → sends as meta.permissionMode
```

## Post-Completion

**Manual verification:**
- Test with a Gemini ACP session to verify metadata-driven model and mode selectors show names
- Test with a Claude session to verify hardcoded mode names are preserved
- Test with a custom ACP agent that provides metadata to verify dynamic rendering
- Verify keys (not names) are sent in message meta and received by backend
- Verify names (not keys) are shown in all UI locations (selectors, status bar, badges)
