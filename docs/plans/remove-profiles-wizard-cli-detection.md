# Plan: Remove Profiles & Wizard, Move CLI Detection to Daemon

## Context

The profiles feature (AI Backend Profiles) is half-baked — it provides env var management per session via a complex sync/schema system, but it's barely used and adds significant complexity. The wizard (new session creation flow) is tightly coupled to profiles. Both should be ripped out.

Simultaneously, CLI availability detection currently happens on-demand from the app via RPC bash calls (`useCLIDetection` hook). This should move to the daemon, which detects availability at boot and re-checks every 20 seconds via the keep-alive, pushing results as part of `MachineMetadata`. The detection must be cross-platform (POSIX + Windows).

The new session creation screen UI will be implemented separately — this plan only covers the cleanup and data flow changes.

---

## Part 1: Move CLI Detection to Daemon (MachineMetadata)

### 1.1 Add `cliAvailability` to `MachineMetadata` schema

**File:** `packages/happy-cli/src/api/types.ts` (line 130)

Add to `MachineMetadataSchema`:
```typescript
cliAvailability: z.object({
  claude: z.boolean(),
  codex: z.boolean(),
  gemini: z.boolean(),
  openclaw: z.boolean(),
  detectedAt: z.number(),
}).optional()
```

Using `.optional()` so older daemons without this field still parse fine.

### 1.2 Add matching field to app-side schema

**File:** `packages/happy-app/sources/sync/storageTypes.ts` (line 119)

Add same `cliAvailability` optional field to the app's `MachineMetadataSchema`.

### 1.3 Implement cross-platform CLI detection in the daemon

**File:** `packages/happy-cli/src/daemon/run.ts`

Add a `detectCLIAvailability()` function that:
- Checks `os.platform()` to pick POSIX vs Windows detection
- **POSIX:** Uses `child_process.execSync` with `command -v claude`, `command -v codex`, `command -v gemini`, and the OpenClaw triple-check (command + config file + env var) — same logic as current `useCLIDetection.ts` lines 66-72
- **Windows:** Uses PowerShell `Get-Command` checks — same logic as `useCLIDetection.ts` lines 74-81
- Returns `{ claude: boolean, codex: boolean, gemini: boolean, openclaw: boolean, detectedAt: number }`
- Wraps in try/catch — on failure, returns all `false` with current timestamp

### 1.4 Run detection at daemon boot

**File:** `packages/happy-cli/src/daemon/run.ts` (line 27-34)

Update `initialMachineMetadata` construction to call `detectCLIAvailability()` and include the result:
```typescript
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
};
```

### 1.5 Re-detect every 20 seconds on keep-alive

**File:** `packages/happy-cli/src/api/apiMachine.ts` (line 299-312)

Modify `startKeepAlive()` to also run `detectCLIAvailability()` every 20 seconds. If the result differs from the last known state, call `updateMachineMetadata()` to push the change. This avoids unnecessary metadata updates when nothing changed.

```
startKeepAlive():
  every 20s:
    emit machine-alive (existing)
    newAvailability = detectCLIAvailability()
    if (newAvailability differs from lastKnownAvailability):
      update machine metadata with new cliAvailability
      lastKnownAvailability = newAvailability
```

The `detectCLIAvailability` function needs to be importable from apiMachine.ts — put it in a shared util like `packages/happy-cli/src/utils/detectCLI.ts`.

### 1.6 Delete `useCLIDetection` hook from app

**File:** `packages/happy-app/sources/hooks/useCLIDetection.ts` — **DELETE**

The app now reads `machine.metadata.cliAvailability` directly from the machine record (already decrypted and available via `useMachine()`). No RPC bash call needed.

---

## Part 2: Remove Profiles Feature

### 2.1 Files to DELETE entirely

| File | Reason |
|------|--------|
| `packages/happy-app/sources/sync/profileUtils.ts` | Built-in profile definitions & docs |
| `packages/happy-app/sources/sync/profileSync.ts` | Profile sync service |
| `packages/happy-app/sources/components/ProfileEditForm.tsx` | Profile editor form |
| `packages/happy-app/sources/components/EnvironmentVariablesList.tsx` | Env var list component |
| `packages/happy-app/sources/components/EnvironmentVariableCard.tsx` | Env var card component |
| `packages/happy-app/sources/hooks/useEnvironmentVariables.ts` | Queries daemon env vars for profiles |
| `packages/happy-app/sources/hooks/envVarUtils.ts` | Env var substitution utils |
| `packages/happy-app/sources/hooks/useCLIDetection.ts` | Replaced by daemon-side detection |
| `packages/happy-app/sources/app/(app)/settings/profiles.tsx` | Profile settings page |

### 2.2 Files to EDIT — remove profile references

**`packages/happy-app/sources/sync/settings.ts`**
- Remove: `AIBackendProfileSchema`, `AnthropicConfigSchema`, `OpenAIConfigSchema`, `AzureOpenAIConfigSchema`, `TogetherAIConfigSchema`, `TmuxConfigSchema`, `EnvironmentVariableSchema`, `ProfileCompatibilitySchema`
- Remove: `getProfileEnvironmentVariables()`, `validateProfileForAgent()`
- Remove from `SettingsSchema`: `profiles` field, `lastUsedProfile` field
- Keep: `lastUsedAgent`, `lastUsedPermissionMode`, `lastUsedModelMode`, `recentMachinePaths` (still useful)

**`packages/happy-app/sources/components/AgentInput.tsx`**
- Remove: imports from `profileUtils` and `settings` (lines 25-26)
- Remove: `profileId` and `onProfileClick` props (lines 77-78)
- Remove: profile data computation (lines 342-351)
- Remove: profile selector button UI (lines 991-1022)

**`packages/happy-app/sources/components/SettingsView.tsx`**
- Remove: profiles settings Item (lines 325-330)

**`packages/happy-app/sources/sync/ops.ts`**
- Remove `environmentVariables` from `SpawnSessionOptions` interface entirely
- Remove `environmentVariables` from the RPC params type in `machineSpawnNewSession()`
- The daemon only uses its own process.env + auth tokens

**`packages/happy-cli/src/persistence.ts`**
- Remove: `AIBackendProfileSchema` duplicate, `validateProfileForAgent()`, `getProfileEnvironmentVariables()`, `readSettings()` profile-related code, `activeProfileId` handling

**`packages/happy-cli/src/daemon/run.ts`**
- Remove: `getProfileEnvironmentVariablesForAgent()` function (lines 37-65)
- Remove: Layer 2 profile env var logic in `spawnSession()` (lines 293-324) — simplify to just auth env + daemon's process.env
- The env merge becomes: `{ ...authEnv }` only, expanded against `process.env`

---

## Part 3: Remove Wizard

### 3.1 Files to DELETE entirely

| File | Reason |
|------|--------|
| `packages/happy-app/sources/app/(app)/new/index.tsx` | Main wizard page — will be replaced with new simpler screen |
| `packages/happy-app/sources/app/(app)/new/pick/machine.tsx` | Machine picker sub-screen (uses SearchableListSelector with favorites) |
| `packages/happy-app/sources/app/(app)/new/pick/path.tsx` | Path picker sub-screen (uses SearchableListSelector with favorites) |
| `packages/happy-app/sources/app/(app)/new/pick/profile-edit.tsx` | Profile edit sub-screen |
| `packages/happy-app/sources/components/NewSessionWizard.tsx` | Legacy wizard component |
| `packages/happy-app/sources/utils/tempDataStore.ts` | Temp data between wizard screens |

Note: `SearchableListSelector` component itself is NOT deleted — it's a generic reusable component. Only its wizard-specific usages (favorites, double-section layout) go away. The new session screen's machine/path pickers will use simpler UI (implemented separately).

### 3.2 Files to EDIT — remove wizard references

**`packages/happy-app/sources/app/(app)/_layout.tsx`**
- Remove: Stack.Screen entries for `new/index`, `new/pick/machine`, `new/pick/path`, `new/pick/profile-edit` (lines 300-327)

**`packages/happy-app/sources/components/MainView.tsx`** — keep `router.push('/new')` (route stays the same)

**`packages/happy-app/sources/components/SidebarView.tsx`** — keep `router.push('/new')`

**`packages/happy-app/sources/components/HomeHeader.tsx`** — keep `router.push('/new')`

**`packages/happy-app/sources/components/CommandPalette/CommandPaletteProvider.tsx`** — keep `router.push('/new')`

**`packages/happy-app/sources/components/EmptySessionsTablet.tsx`** — keep `router.push('/new')`

All navigation stays at `/new` — no route changes needed.

**`packages/happy-app/sources/sync/persistence.ts`**
- KEEP: `NewSessionDraft` type, `loadNewSessionDraft()`, `saveNewSessionDraft()`, `clearNewSessionDraft()` — useful for the new simpler session screen too (stores machine, path, agent, permissions)

**`packages/happy-app/sources/sync/settings.ts`**
- Remove: `useEnhancedSessionWizard` from settings
- Remove: `favoriteDirectories` — only used by wizard's SearchableListSelector
- Remove: `favoriteMachines` — only used by wizard's SearchableListSelector

### 3.3 Translations cleanup

Remove from ALL language files (`en.ts`, `ru.ts`, `pl.ts`, `es.ts`, `ca.ts`, `it.ts`, `pt.ts`, `ja.ts`, `zh-Hans.ts`):
- `profiles.*` section entirely
- `newSession.*` section entirely
- `settings.profiles` and `settings.profilesSubtitle` keys
- `settingsFeatures.enhancedSessionWizard*` keys

---

## Part 4: Placeholder for New Session Route

Since the new UI will be implemented separately, create a minimal placeholder:

**`packages/happy-app/sources/app/(app)/new/index.tsx`** — replace with stub that:
- Shows "New Session" header
- Has the `AgentInput` composer at the bottom (reuse existing component)
- Reads `lastUsedAgent`, `lastUsedPermissionMode`, `lastUsedModelMode` from settings for defaults
- Calls `machineSpawnNewSession()` with machineId + directory + agent
- This is a temporary bridge — the full UI from the mockup will be built later

---

## Data Flow: Before vs After

### BEFORE (Current)
```
APP (wizard)                          DAEMON
├─ User picks machine
├─ useCLIDetection() ──RPC bash──→    ├─ runs `command -v` checks
│  ← parses stdout ──────────────     │
├─ User picks agent (filtered)
├─ User picks profile
├─ getProfileEnvironmentVariables()
├─ machineSpawnNewSession({
│    machineId, dir, agent,
│    environmentVariables })
│  ──RPC──────────────────────────→   ├─ receives env vars
│                                     ├─ merges: profileEnv + authEnv
│                                     ├─ expands ${VAR} refs
│                                     ├─ spawns agent with merged env
│                                     └─
```

### AFTER (New)
```
DAEMON BOOT
├─ detectCLIAvailability()
├─ include in MachineMetadata
├─ POST /v1/machines (or update)
│
DAEMON KEEP-ALIVE (every 20s)
├─ emit machine-alive
├─ re-detect CLI availability
├─ if changed → machine-update-metadata
│
APP (new session screen)
├─ Read machine.metadata.cliAvailability (already there, no RPC)
├─ User picks agent (filtered by availability)
├─ machineSpawnNewSession({
│    machineId, dir, agent })
│  ──RPC──────────────────────────→   DAEMON
│                                     ├─ auth env only (no profiles)
│                                     ├─ spawns with process.env + authEnv
│                                     └─
```

---

## Verification

1. **Typecheck:** `yarn typecheck` in `happy-app` and `happy-cli` — must pass with no errors
2. **Daemon boot:** Start daemon, verify `initialMachineMetadata` includes `cliAvailability` in logs
3. **Keep-alive re-detection:** Install/uninstall a CLI tool, verify metadata updates within 20s
4. **App reads availability:** Open app, select a machine, verify availability shows from metadata (no bash RPC)
5. **Session spawn:** Create session from app — verify it spawns without profile env vars, using daemon's process.env
6. **Cross-platform:** Test detection commands on macOS (POSIX) — Windows testing if available
7. **No orphaned data:** Verify old `profiles` key in MMKV is ignored (schema no longer reads it)
8. **Navigation:** Verify all FAB/sidebar/header buttons navigate to the new session route
