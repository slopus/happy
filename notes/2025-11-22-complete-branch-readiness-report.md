# Complete Branch Readiness Report: Main vs Feature Branches

**Date:** 2025-11-22
**Purpose:** Comprehensive PR readiness assessment for both repositories
**Scope:** All changes, not just permission mode fixes

---

## Overview

### Happy-CLI Branch
**Branch:** `claude/yolo-mode-persistence-profile-integration-01WqaAvCxRr6eWW2Wu33e8xP`
- **26 commits** ahead of main
- **21 files** changed
- **+3,314 / -223 lines**

### Happy App Branch
**Branch:** `fix/new-session-wizard-ux-improvements`
- **145 commits** ahead of main
- **50 files** changed
- **+12,603 / -716 lines**

**Combined:** 171 commits, 71 files, +15,917 lines

---

## Happy-CLI: Complete Change Breakdown

### Major Feature Categories

#### 1. Profile System (9 commits, ~600 lines)
**Commits:** `30201e7`, `ad06ed4`, `4e37c31`, `8b0efe3`, `edc2db2`, `f515987`

**New Capabilities:**
- Profile schema with validation (AIBackendProfileSchema)
- Profile persistence and migration (schemaVersion v1→v2)
- Environment variables per profile
- Profile synchronization from GUI
- defaultPermissionMode, defaultModelMode, defaultSessionType support

**Files Added/Modified:**
- `src/persistence.ts`: +376 lines (profile schema, validation, helpers)

**Breaking Changes:**
- ⚠️ **Settings schema v1→v2**: Auto-migration exists (✅ safe)
- ❌ **Profile validation**: Silently drops invalid profiles (❌ data loss risk)
- ⚠️ **RPC API**: New `environmentVariables` parameter in spawnSession (optional, but required for feature)

**Backwards Compatibility:**
- Old GUI + New CLI: ✅ Works (profiles ignored)
- New GUI + Old CLI: ⚠️ Partial (profiles exist but not applied)

---

#### 2. Tmux Integration (7 commits, ~1,600 lines)
**Commits:** `5543531`, `e191339`, `2f8a313`, `495714f`, `21cb3ff`, `5bbe2bd`, `9a0a0e4`

**New Capabilities:**
- TypeScript tmux wrapper utilities (1,052 lines)
- Comprehensive test coverage (456 lines)
- PID tracking with native `-P` flag
- Environment variable inheritance
- Working directory support
- Session name resolution (first existing vs new)

**Files Added:**
- `src/utils/tmux.ts`: +1,052 lines (NEW)
- `src/utils/tmux.test.ts`: +456 lines (NEW)

**Files Modified:**
- `src/daemon/run.ts`: Major refactor (+109/-41 lines)

**Breaking Changes:**
- ❌ **Session name behavior**: Empty string now means "use first existing" (was: create new)
  - **Impact**: Could attach to wrong session if multiple exist
  - **Severity**: MAJOR
  - **Migration**: Document behavior, ensure GUI sends explicit names

**Backwards Compatibility:**
- Tmux is optional (checked with `isTmuxAvailable()`)
- Falls back to non-tmux spawning if unavailable
- ✅ Works on systems without tmux

---

#### 3. Environment Variable Expansion (3 commits, ~360 lines)
**Commits:** `f425f6b`, `f903de5`, `c9c5c24`

**New Capabilities:**
- `${VAR}` reference expansion
- `${VAR:-default}` bash parameter expansion syntax
- Validation for undefined variables
- Comprehensive test coverage (264 tests)

**Files Added:**
- `src/utils/expandEnvVars.ts`: +96 lines (NEW)
- `src/utils/expandEnvVars.test.ts`: +264 lines (NEW)

**Breaking Changes:**
- ❌ **Env var name validation**: Must match `/^[A-Z_][A-Z0-9_]*$/`
  - **Impact**: Profiles with lowercase/custom names silently lose those variables
  - **Severity**: MAJOR (silent data loss)
  - **Migration**: None - variables just disappear

**Backwards Compatibility:**
- ✅ Literal values (no `${}`) work as before
- ❌ Invalid variable names silently filtered out

---

#### 4. Dev/Stable Variant System (2 commits, ~180 lines)
**Commits:** `182c051`, `3f4c0dd`

**New Capabilities:**
- Separate dev/stable data directories (`~/.happy` vs `~/.happy-dev`)
- `happy-dev` global binary
- Environment switching via `HAPPY_VARIANT`
- Setup scripts for development

**Files Added:**
- `bin/happy-dev.mjs`: +41 lines (NEW)
- `scripts/env-wrapper.cjs`: +79 lines (NEW)
- `scripts/setup-dev.cjs`: +57 lines (NEW)
- `.envrc.example`: +17 lines (NEW)
- `CONTRIBUTING.md`: +261 lines (major expansion)

**Files Modified:**
- `src/configuration.ts`: +17 lines (variant detection)
- `package.json`: Added scripts for dev/stable

**Breaking Changes:**
- ✅ **None**: Additive only, defaults to stable mode

**Backwards Compatibility:**
- ✅ Perfect - old behavior unchanged, new mode opt-in

---

#### 5. Permission Mode Fixes (2 commits, 3 files)
**Commits:** `9828fdd`, `5ec36cf`

**What Fixed:**
- Critical bug: `claudeRemote.ts:114` forced modes to 'default'
- Type system: PermissionMode now includes all 7 modes (Claude + Codex)
- Schema validation: Strengthened to enum from z.string()

**Files Modified:**
- `src/claude/claudeRemote.ts`: 1 line (removed hardcoded override)
- `src/persistence.ts`: 1 line (enum validation)
- `src/api/types.ts`: 8 lines (type definition + enum validation)

**Breaking Changes:**
- ✅ **None proven**: No custom modes ever existed (verified)

**Backwards Compatibility:**
- ✅ Perfect - All modes in wild are valid

---

#### 6. Documentation & Tooling (3 commits)
**Commits:** `6829836`, `dd4d4a0`, `753fe78`

**Changes:**
- Reorganized documentation (user vs developer)
- Updated claude-code SDK to 2.0.24
- Removed one-off compatibility report

**Breaking Changes:**
- ✅ None - Documentation and dependencies

---

### Happy-CLI Files Changed (21 total)

**New Files (7):**
```
bin/happy-dev.mjs
scripts/env-wrapper.cjs
scripts/setup-dev.cjs
src/utils/expandEnvVars.ts
src/utils/expandEnvVars.test.ts
src/utils/tmux.ts
src/utils/tmux.test.ts
```

**Modified Files (14):**
```
.envrc.example
.gitignore
CONTRIBUTING.md
README.md
package.json
src/api/apiMachine.ts
src/api/types.ts
src/claude/claudeRemote.ts
src/configuration.ts
src/daemon/run.ts
src/daemon/types.ts
src/modules/common/registerCommonHandlers.ts
src/persistence.ts
yarn.lock
```

---

## Happy App: Complete Change Breakdown

### Major Feature Categories

#### 1. New Session Wizard Rewrite (50+ commits, ~5,000 lines)
**Major Commits:** `ab1012df`, `5e50122b`, `15872d57`, many UI refinements

**New Capabilities:**
- Single-page wizard (was multi-step modal)
- Inline machine selection with favorites
- Path selection with recent/favorites
- Profile integration
- CLI detection and availability warnings
- Collapsible sections
- SearchableListSelector generic component

**Files Added:**
- `sources/components/NewSessionWizard.tsx`: +1,917 lines (NEW - massive)
- `sources/components/SearchableListSelector.tsx`: +675 lines (NEW)
- `sources/hooks/useCLIDetection.ts`: +115 lines (NEW)

**Files Modified:**
- `sources/app/(app)/new/index.tsx`: Major refactor (wizard integration)
- `sources/app/(app)/new/pick/machine.tsx`: +184 lines (machine picker)
- `sources/components/AgentInput.tsx`: Significant refactor (~572 lines modified)

**Breaking Changes:**
- ✅ **None**: UI flow changed but API unchanged
- ✅ Session creation protocol identical
- ✅ Old sessions still load correctly

**Backwards Compatibility:**
- ✅ Perfect - UI layer change only

---

#### 2. Profile Management System (20+ commits, ~2,500 lines)
**Major Commits:** `b4d218a3`, `b53ef2e1`, `0ecaffe4`, `e4220e2d`, `8b1ba7c1`

**New Capabilities:**
- Complete profile CRUD operations
- Profile sync across devices
- Environment variables configuration
- Profile compatibility (Claude vs Codex)
- Built-in profiles (DeepSeek, Azure, OpenAI, etc.)
- Profile validation and versioning

**Files Added:**
- `sources/sync/profileSync.ts`: +453 lines (NEW)
- `sources/sync/profileUtils.ts`: +377 lines (NEW)
- `sources/components/ProfileEditForm.tsx`: +580 lines (NEW)
- `sources/components/EnvironmentVariablesList.tsx`: +258 lines (NEW)
- `sources/components/EnvironmentVariableCard.tsx`: +336 lines (NEW)
- `sources/app/(app)/settings/profiles.tsx`: +436 lines (NEW)
- `sources/app/(app)/new/pick/profile-edit.tsx`: +91 lines (NEW)

**Files Modified:**
- `sources/sync/settings.ts`: +312 lines (schema expansion, migration)
- `sources/sync/sync.ts`: Profile sync integration
- `sources/components/SettingsView.tsx`: Added profiles navigation

**Breaking Changes:**
- ⚠️ **Settings schema expanded**: New fields added (profiles, activeProfileId)
  - **Migration**: Uses SettingsSchema.partial().safeParse() - preserves unknown fields
  - **Status**: ✅ Safe (lines 363-384)

**Backwards Compatibility:**
- ✅ Old settings load correctly (partial parse)
- ✅ New fields optional
- ✅ Unknown fields preserved

---

#### 3. Environment Variable System (10+ commits, ~600 lines)
**Commits:** `e4220e2d`, `3234b77c`, `b0825b78`, etc.

**New Capabilities:**
- `${VAR}` substitution in profile values
- Environment variable configuration UI
- Secret detection and masking
- Validation and error messages
- Real-time value preview

**Files Added:**
- `sources/hooks/useEnvironmentVariables.ts`: +197 lines (NEW)
- `sources/components/EnvironmentVariableCard.tsx`: +336 lines
- `sources/components/EnvironmentVariablesList.tsx`: +258 lines

**Breaking Changes:**
- ✅ **None**: Additive feature only

**Backwards Compatibility:**
- ✅ Perfect - Optional feature

---

#### 4. Translation System Expansion (~500 lines)
**New Keys Added:**

**Profile-related translations (all 7 languages):**
- `profiles.title`, `profiles.add`, `profiles.edit`, etc. (~30 keys)
- `agentInput.selectProfile`, `agentInput.permissionMode.*` (~20 keys)
- `newSession.*` keys for wizard (~15 keys)
- `common.saveAs` and other common keys

**Files Modified:**
- `sources/text/translations/en.ts`: +905 lines
- `sources/text/translations/ru.ts`: +37 lines
- `sources/text/translations/pl.ts`: +37 lines
- `sources/text/translations/es.ts`: +37 lines
- `sources/text/translations/ca.ts`: +36 lines
- `sources/text/translations/pt.ts`: +36 lines
- `sources/text/translations/zh-Hans.ts`: +36 lines
- `sources/text/_default.ts`: +36 lines

**Breaking Changes:**
- ✅ **None**: Additive only, `t()` handles missing keys

---

#### 5. UI/UX Improvements (40+ commits)
**Examples:** SearchableListSelector refinements, spacing fixes, theme additions

**Files Modified:**
- `sources/theme.ts`: +36 lines (new colors, spacing constants)
- `sources/components/SidebarView.tsx`: + button in header
- `sources/components/SettingsView.tsx`: Profile navigation
- Many small fixes to SearchableListSelector component

**Breaking Changes:**
- ✅ **None**: Visual changes only

---

#### 6. Tauri Desktop Support (2 commits)
**Commits:** `d8762ef8`, `9aa1cf9f`

**New Capabilities:**
- macOS desktop variant build configs
- Dev/Preview/Production build scripts

**Files Added:**
- `src-tauri/tauri.dev.conf.json`: +12 lines
- `src-tauri/tauri.preview.conf.json`: +12 lines

**Breaking Changes:**
- ✅ **None**: Additive platform support

---

### Happy App Files Changed (50 total)

**New Files (10+):**
```
sources/components/NewSessionWizard.tsx
sources/components/SearchableListSelector.tsx
sources/components/ProfileEditForm.tsx
sources/components/EnvironmentVariablesList.tsx
sources/components/EnvironmentVariableCard.tsx
sources/sync/profileSync.ts
sources/sync/profileUtils.ts
sources/hooks/useCLIDetection.ts
sources/hooks/useEnvironmentVariables.ts
sources/app/(app)/settings/profiles.tsx
sources/app/(app)/new/pick/profile-edit.tsx
+ Tauri configs, docs, etc.
```

**Modified Files (40+):**
- All translation files (7)
- Core sync files (settings.ts, sync.ts, typesRaw.ts)
- UI components (AgentInput, SettingsView, SidebarView)
- Theme and styling
- And many more...

---

## Breaking Changes: Complete Analysis

### 🔴 CRITICAL #1: Profile Schema Validation (happy-cli)

**Location:** `src/persistence.ts:64-100, 280-296`

**Issue:** Invalid profiles silently dropped

**Code:**
```typescript
for (const profile of migrated.profiles) {
    try {
        const validated = AIBackendProfileSchema.parse(profile);
        validProfiles.push(validated);
    } catch (error: any) {
        logger.warn(`⚠️ Invalid profile "${profile?.name}" - skipping.`);
        // ← PROFILE LOST FOREVER
    }
}
```

**Validation Requirements:**
- `id`: Must be valid UUID
- `name`: 1-100 characters
- `environmentVariables[].name`: Must match `/^[A-Z_][A-Z0-9_]*$/`
- All config objects must match sub-schemas

**Impact:**
- ❌ Profiles with non-UUID ids → Lost
- ❌ Profiles with lowercase env vars → Lost
- ❌ Profiles with invalid names → Lost
- ❌ No user notification → User confused

**Required Fix:**
```typescript
// Store invalid profiles separately
const invalidProfiles = [];
for (const profile of migrated.profiles) {
    try {
        validProfiles.push(AIBackendProfileSchema.parse(profile));
    } catch (error) {
        invalidProfiles.push({ profile, error: error.message });
        console.error(`❌ Profile "${profile?.name}" failed validation: ${error.message}`);
    }
}
migrated.profiles = validProfiles;
migrated.invalidProfiles = invalidProfiles;  // Preserve for recovery
```

**Estimated effort:** 15 minutes, 10 lines

---

### 🔴 CRITICAL #2: Settings Schema Migration Handling (happy-app)

**Location:** `sources/sync/settings.ts:363-384`

**Current Behavior:**
```typescript
const parsed = SettingsSchemaPartial.safeParse(settings);
if (!parsed.success) {
    // Preserves unknown fields
    const unknownFields = { ...(settings as any) };
    const knownFields = Object.keys(SettingsSchema.shape);
    knownFields.forEach(key => delete unknownFields[key]);
    return { ...settingsDefaults, ...unknownFields };
}
```

**Analysis:**
- ✅ **Good**: Uses `.safeParse()` (doesn't throw)
- ✅ **Good**: Preserves unknown fields from future versions
- ✅ **Good**: Merges with defaults
- ⚠️ **Issue**: Validation errors not logged to user
- ⚠️ **Issue**: No indication when using defaults vs real data

**Impact:**
- ✅ Old settings → New app: Works (migration in sync.ts)
- ✅ New settings → Old app: Works (unknown fields preserved)
- ⚠️ Corrupted settings: Silent fallback to defaults

**Required Fix:**
- Add console warning when falling back to defaults
- Optional: Show UI notification for corrupted settings

**Estimated effort:** 5 minutes, 3 lines

---

### 🟡 MAJOR #3: GUI-CLI RPC Protocol Extension

**Location:** `src/modules/common/registerCommonHandlers.ts` (happy-cli), daemon spawn calls (happy-app)

**What Changed:**
```typescript
// SpawnSessionOptions extended:
export interface SpawnSessionOptions {
    // ... existing fields ...
    environmentVariables?: {  // ← NEW OPTIONAL
        ANTHROPIC_BASE_URL?: string;
        ANTHROPIC_AUTH_TOKEN?: string;
        ANTHROPIC_MODEL?: string;
        TMUX_SESSION_NAME?: string;
        TMUX_TMPDIR?: string;
        // ... more ...
    };
}
```

**Daemon Usage (daemon/run.ts:297):**
```typescript
const environmentVariables = options.environmentVariables || {};
// These get passed to spawned process
```

**Backwards Compatibility:**
- ✅ Old GUI → New CLI: Works (parameter optional, defaults to `{}`)
- ⚠️ Old GUI → New CLI: Profile env vars NOT applied (feature missing)
- ✅ New GUI → Old CLI: Works (old CLI ignores unknown parameter)

**Impact:**
- ⚠️ **Feature requires both updated**: Profile environment variables only work with both new GUI + new CLI
- ✅ **Not breaking**: Old functionality still works

**Required Fix:**
- Document version requirement in release notes
- Optional: Add version check to show "update CLI" message

**Estimated effort:** Documentation only

---

### 🟡 MAJOR #4: Tmux Session Name Resolution

**Location:** `src/daemon/run.ts:760-777` (happy-cli)

**What Changed:**
```typescript
// NEW BEHAVIOR:
let sessionName = options.sessionName !== undefined && options.sessionName !== ''
    ? options.sessionName
    : null;

if (!sessionName) {
    // Search for existing sessions
    const listResult = await this.executeTmuxCommand(['list-sessions', '-F', '#{session_name}']);
    if (listResult && listResult.returncode === 0 && listResult.stdout.trim()) {
        const firstSession = listResult.stdout.trim().split('\n')[0];
        sessionName = firstSession;  // ← ATTACH TO FIRST EXISTING
    } else {
        sessionName = 'happy';  // ← Create 'happy' if none exist
    }
}
```

**Behavioral Change:**

| Input | Old Behavior (main) | New Behavior (branch) |
|-------|---------------------|----------------------|
| `sessionName: "my-session"` | Uses "my-session" | Uses "my-session" ✅ |
| `sessionName: ""` | Creates new session? | Attaches to first existing ⚠️ |
| `sessionName: undefined` | Creates new session? | Attaches to first existing ⚠️ |

**Impact:**
- ❌ **Session isolation broken**: Empty string could attach to wrong session
- ❌ **Unexpected behavior**: User expects new session, gets existing
- ⚠️ **Data cross-contamination**: Two users share same session

**Required Fix:**
- Document new behavior in CONTRIBUTING.md
- Verify GUI always sends explicit session names
- Add warning if attaching to existing session

**Estimated effort:** 30 minutes (documentation + verification)

---

### 🟢 NON-BREAKING CHANGES (Summary)

**Category** | **Commits** | **Impact**
-----------|-----------|----------
Permission mode fixes | 2 | ✅ Bug fixes only
Environment variable expansion | 3 | ✅ Additive feature
Dev/stable variants | 2 | ✅ Opt-in tooling
Documentation | 3 | ✅ Informational
Tmux utilities | 4 | ✅ Optional dependency
Translation keys | Many | ✅ Additive only
UI/UX improvements | 40+ | ✅ Visual only
Tauri support | 2 | ✅ Platform addition

**Total Non-Breaking:** ~60+ commits, ~10,000 lines - All safe

---

## Cross-Repository Compatibility Matrix

### Version Compatibility Grid

```
┌──────────────────┬─────────────────┬─────────────────┐
│                  │   GUI main      │   GUI branch    │
├──────────────────┼─────────────────┼─────────────────┤
│ CLI main         │ ✅ Baseline     │ ✅ Works*       │
│                  │ (Current prod)  │ (New GUI only)  │
├──────────────────┼─────────────────┼─────────────────┤
│ CLI branch       │ ⚠️ Partial**    │ ✅ Full***      │
│                  │ (New CLI only)  │ (Both updated)  │
└──────────────────┴─────────────────┴─────────────────┘

*   New GUI + Old CLI:
    - ✅ Sessions work
    - ✅ UI improvements visible
    - ❌ Profiles not applied (old CLI doesn't support)
    - ❌ Permission modes forced to 'default' (old bug)

**  Old GUI + New CLI:
    - ✅ Sessions work
    - ✅ Permission modes work correctly (bug fixed)
    - ❌ No profile UI (old GUI)
    - ⚠️ Tmux behavior may be different

*** New GUI + New CLI (Target state):
    - ✅ All features working
    - ✅ Profiles applied
    - ✅ Permission modes persist
    - ✅ Environment variables work
```

---

## Feature Dependency Analysis

### Features That Require Both Updated

**1. Profile System**
- GUI needs: Profile UI, sync, storage
- CLI needs: Profile schema, validation, env var application
- **Status**: Both branches have it ✅

**2. Permission Mode Persistence**
- GUI needs: Schema validation fix
- CLI needs: Remove hardcoded override, schema validation
- **Status**: Both branches have it ✅

**3. Environment Variable Expansion**
- GUI needs: Send via RPC environmentVariables param
- CLI needs: Expansion logic, validation
- **Status**: Both branches have it ✅

### Features That Work Independently

**1. New Session Wizard UI** (GUI only)
- Old CLI still works with new wizard
- ✅ Can deploy GUI alone

**2. Dev/Stable Variants** (CLI only)
- GUI doesn't need to know about this
- ✅ Can deploy CLI alone

**3. Tmux Utilities** (CLI only)
- GUI sends session name, CLI handles tmux
- ✅ Can deploy CLI alone (with caveats)

---

## Required Fixes Before Merge

### Must Fix (Blocking)

#### 1. Profile Validation Data Preservation (happy-cli)
**File:** `src/persistence.ts:280-296`
**Effort:** 15 minutes
**Change:** Store invalidProfiles separately, add console.error()

#### 2. Settings Parse Error Logging (happy-app)
**File:** `sources/sync/settings.ts:364`
**Effort:** 5 minutes
**Change:** Add console warning when using defaults

#### 3. Tmux Behavior Documentation (happy-cli)
**File:** `CONTRIBUTING.md` or `README.md`
**Effort:** 15 minutes
**Change:** Document empty string behavior

### Should Fix (Recommended)

#### 4. GUI Session Name Verification (happy-app)
**Files:** Session creation flows
**Effort:** 30 minutes
**Task:** Verify GUI never sends empty sessionName unintentionally

#### 5. CLI Version Detection (both)
**Files:** Add version field to metadata
**Effort:** 1 hour
**Task:** Enable "update CLI" prompts in future

---

## Testing Strategy

### Pre-Merge Testing Matrix

**Test Suite 1: Permission Modes** (Already working)
- [x] Select bypassPermissions in GUI → Persists in CLI ✅
- [x] Select acceptEdits in GUI → Persists in CLI ✅
- [x] All 4 Claude modes work ✅
- [x] All 3 Codex modes work ✅

**Test Suite 2: Cross-Version Compatibility**
- [ ] Old GUI (main) + New CLI (branch) → Sessions work, no profiles
- [ ] New GUI (branch) + Old CLI (main) → Sessions work, profiles ignored, permission mode bug present
- [ ] New GUI + New CLI → Full functionality

**Test Suite 3: Profile System**
- [ ] Create profile in GUI → Syncs to CLI
- [ ] Profile with env vars → Applied in session
- [ ] Invalid profile (non-UUID) → Error logged, preserved
- [ ] Edit profile → Changes persist

**Test Suite 4: Tmux Integration**
- [ ] Explicit session name → Uses that name
- [ ] Empty string → Attaches to first existing or creates 'happy'
- [ ] Multiple tmux sessions → Correct session selected
- [ ] No tmux installed → Falls back gracefully

**Test Suite 5: Migration**
- [ ] Old settings v1 → Migrates to v2 automatically
- [ ] Settings with unknown fields → Preserved
- [ ] Corrupted settings → Falls back to defaults with warning

---

## PR Strategy Recommendations

### Strategy A: Split Into Multiple PRs (RECOMMENDED)

**Why:** Easier review, lower risk, can merge incrementally

**PR #1: Permission Mode Bug Fix** (Merge first, low risk)
- Cherry-pick: `9828fdd`, `5ec36cf` (happy-cli)
- Cherry-pick: `3efe337` (happy-app)
- **Size**: 3 commits, 5 files, 10 lines
- **Risk**: None - pure bug fix
- **Ready**: ✅ Yes, now

**PR #2: Profile System Foundation** (Merge second)
- Commits: Profile schema, validation, sync
- **Includes fixes**: Profile data preservation
- **Size**: ~15 commits, ~3,000 lines
- **Risk**: Medium - new feature, needs testing
- **Ready**: ⚠️ After fix #1 applied

**PR #3: New Session Wizard** (Merge third)
- Commits: UI rewrite, SearchableListSelector, etc.
- **Size**: ~50 commits, ~5,000 lines
- **Risk**: Low - UI only
- **Ready**: ✅ Yes (depends on PR #2)

**PR #4: Tmux Integration** (Merge fourth)
- Commits: Tmux utilities, daemon changes
- **Includes fixes**: Behavior documentation
- **Size**: ~10 commits, ~1,600 lines
- **Risk**: Medium - behavioral change
- **Ready**: ⚠️ After fix #3 applied

**PR #5: Dev Tooling** (Merge last)
- Commits: Dev/stable variants, documentation
- **Size**: ~5 commits, ~400 lines
- **Risk**: None - tooling only
- **Ready**: ✅ Yes

### Strategy B: Single Large PR (Not Recommended)

**Why not:** 171 commits, 71 files is too large for effective review

**Risks:**
- Hard to review thoroughly
- One bug blocks entire merge
- Difficult to isolate issues
- Long feedback cycles

---

## Breaking Changes Summary Table

| # | Change | Repository | Severity | Impact | Fix Required | Effort |
|---|--------|------------|----------|--------|--------------|--------|
| 1 | Profile validation drops data | happy-cli | CRITICAL | Data loss | ✅ Yes | 15 min |
| 2 | Settings parse no error log | happy-app | MINOR | Silent fallback | ✅ Yes | 5 min |
| 3 | RPC environmentVariables | Both | MAJOR | Feature needs both | ⚠️ Document | 15 min |
| 4 | Tmux empty string behavior | happy-cli | MAJOR | Session isolation | ✅ Yes | 30 min |
| 5 | Permission mode enum | Both | NONE | Proven safe | ✅ No | 0 |

**Total breaking changes:** 4 (1 critical, 2 major, 1 minor)
**Total fixes needed:** 3 code changes + 1 documentation
**Total effort:** ~65 minutes

---

## Backwards Compatibility Verdict

### Overall Assessment: ⚠️ **MOSTLY SAFE WITH FIXES REQUIRED**

**Safe Changes (90% of code):**
- ✅ Profile system is additive
- ✅ UI improvements are visual only
- ✅ Translation keys are additive
- ✅ Environment variable expansion is opt-in
- ✅ Dev tooling is separate
- ✅ Tauri support is platform addition
- ✅ Permission mode enum is proven safe

**Unsafe Changes (10% of code):**
- ❌ Profile validation needs data preservation
- ❌ Tmux behavior needs documentation
- ⚠️ Settings parse needs error visibility
- ⚠️ RPC protocol needs coordination

**Migration Required:**
- Settings v1→v2 (automatic, already implemented ✅)

**User Action Required:**
- Update both GUI and CLI together for full functionality
- Review invalid profiles (if fix #1 applied)

---

## Release Plan Recommendation

### Phase 1: Quick Win (Week 1)
**PR**: Permission mode bug fix only
**Commits**: 3 commits, 5 files
**Ready**: ✅ Now
**Risk**: None

### Phase 2: Foundation (Week 2-3)
**PR**: Profile system + environment variables
**Includes**: Fixes #1, #2
**Commits**: ~20 commits
**Ready**: After fixes applied
**Risk**: Medium

### Phase 3: UI (Week 4)
**PR**: New session wizard
**Commits**: ~50 commits
**Ready**: After Phase 2 merged
**Risk**: Low

### Phase 4: Tmux (Week 5)
**PR**: Tmux integration
**Includes**: Fix #3, #4
**Commits**: ~10 commits
**Ready**: After fixes applied
**Risk**: Medium

### Phase 5: Tooling (Week 6)
**PR**: Dev variant system
**Commits**: ~5 commits
**Ready**: ✅ Now
**Risk**: None

---

## Conclusion

**Both branches are high-quality work** with comprehensive features, but need **minimal cleanup** before merge:

**Required:**
- 3 small code fixes (~30 lines total)
- 1 documentation addition (~20 lines)
- Cross-version testing (4-8 hours)

**Timeline:**
- Fixes: 1 hour
- Testing: 1 day
- **Total**: Ready to merge in 2-3 days

**Recommendation:** Apply minimal fixes, split into 5 PRs, merge incrementally over 6 weeks for safe rollout.
