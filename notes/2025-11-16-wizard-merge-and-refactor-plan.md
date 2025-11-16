# 2025-11-16 Wizard Merge and Refactor Plan

## Objective

Merge `feature/yolo-mode-persistence-and-profile-management-wizard` into `fix/yolo-mode-persistence-and-profile-management-wizard`, then refactor to single-page design.

## Current State

- **Branch:** `fix/yolo-mode-persistence-and-profile-management-wizard`
- **Commit:** `0abfc207` "fix(GUI): change new session wizard from modal to inline navigation"
- **Backup Branch Created:** `fix/yolo-mode-persistence-and-profile-management-wizard-backup`
- **Merge Status:** IN PROGRESS (started but not committed)

## Why Manual Merge Required

1. **Credit Denys Vitali:** His commit `36ad0947` "feat: use wizard for new session" must appear in git history
2. **Preserve All Features:** Must keep ALL functionality from both branches
3. **No Regressions:** Cannot break existing working wizard

## Conflicts to Resolve Manually

### 1. sources/app/(app)/new/index.tsx
**Ours (fix/yolo):** 1048 lines, complete inline wizard with 4 steps
**Theirs (feature/yolo):** 286 lines, wrapper that uses `<NewSessionWizard/>` component

**Resolution:** Keep OURS (complete working wizard)
**Method:** `git checkout --ours 'sources/app/(app)/new/index.tsx'`

### 2. sources/components/AgentInput.tsx
**Conflict:** Both versions have profile-related code

**Ours (fix/yolo):**
- Line 22: `import { AIBackendProfile } from '@/sync/settings';`
- Lines 27-178: ProfileDisplay interface, DEFAULT_PROFILES, getBuiltInProfile() function

**Theirs (feature/yolo):**
- Line 26: `import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';`
- NO ProfileDisplay, DEFAULT_PROFILES, or getBuiltInProfile (cleaner)

**Resolution:** Keep THEIRS (cleaner version without profile utilities)
**Rationale:** Profile utilities should be in shared file (profileUtils.ts), not in AgentInput
**Method:** Manual edit to remove duplicate import and profile code

### 3. sources/sync/ops.ts
**Conflict:** environmentVariables type definition

**Ours (fix/yolo):**
```typescript
environmentVariables?: {
    // Anthropic Claude API configuration
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_AUTH_TOKEN?: string;
    ANTHROPIC_MODEL?: string;
    // ... many more with comments
}
```

**Theirs (feature/yolo):**
```typescript
environmentVariables?: Record<string, string | undefined>;
```

**Resolution:** Keep OURS (more specific type definition with documentation)
**Method:** `git checkout --ours sources/sync/ops.ts`

### 4. sources/sync/settings.ts
**Conflict:** Profile schema definitions

**Resolution:** Keep OURS (more complete schema)
**Method:** `git checkout --ours sources/sync/settings.ts`

### 5. sources/text/translations/en.ts
**Conflict:** ADD/ADD (both created file)

**Resolution:** Keep OURS (has all translations from fix/yolo work)
**Method:** `git checkout --ours sources/text/translations/en.ts`

## Manual Merge Execution Steps

1. ✅ DONE: Create backup branch
2. ✅ DONE: Start merge with `git merge feature/yolo --no-ff --no-commit`
3. ⏳ IN PROGRESS: Resolve conflicts manually

### Detailed Resolution Process

```bash
# Conflict 1: new/index.tsx - Keep ours (complete wizard)
git checkout --ours 'sources/app/(app)/new/index.tsx'
git add 'sources/app/(app)/new/index.tsx'

# Conflict 2: AgentInput.tsx - MANUALLY EDIT
# - Read both versions
# - Keep theirs as base
# - Verify no profile utilities remain
# - Fix any duplicate imports
# - Save and stage

# Conflict 3: ops.ts - Keep ours (detailed types)
git checkout --ours sources/sync/ops.ts
git add sources/sync/ops.ts

# Conflict 4: settings.ts - Keep ours (complete schema)
git checkout --ours sources/sync/settings.ts
git add sources/sync/settings.ts

# Conflict 5: en.ts - Keep ours (all translations)
git checkout --ours sources/text/translations/en.ts
git add sources/text/translations/en.ts

# Verify NO conflict markers remain
grep -r "<<<<<<< HEAD" sources/ || echo "✓ Clean"

# Commit merge
git commit -m "[message crediting Denys Vitali]"
```

## Post-Merge: Single-Page Refactor

### Step-by-Step Refactor Plan

**File:** sources/app/(app)/new/index.tsx

**Remove:**
1. Line 27: `type WizardStep = 'welcome' | 'ai-backend' | 'session-details' | 'creating';`
2. Lines 30-40: Module-level callbacks
3. Line 481: `const [currentStep, setCurrentStep] = ...`
4. Lines 569-601: `goToNextStep()` function
5. Lines 588-612: `goToPreviousStep()` function
6. Lines 673-681: `handleMachineClick()` and `handlePathClick()`
7. Lines 784-1022: `renderStepContent()` function
8. Line 1041: Call to `renderStepContent()`

**Add:**
1. Inline profile grid section (content from lines 788-857)
2. Inline machine selector (list with checkmarks)
3. Inline path TextInput
4. Collapsible advanced options
5. Prompt TextInput (multiline)
6. Create button (disabled when !canCreate)

**Keep:**
- All state management
- All handlers (handleCreateSession, selectProfile, createNewProfile)
- All validation logic
- All computed values (compatibleProfiles, selectedProfile, selectedMachine)

## Validation Before Commit

- [ ] Build compiles without errors
- [ ] New session button appears
- [ ] Wizard shows as single page
- [ ] All profile cards render
- [ ] Machine selection works
- [ ] Path input works
- [ ] Create button disabled when fields missing
- [ ] Create button enabled when fields valid
- [ ] Session creation works with profile env vars

## Files to Delete After Refactor

- sources/app/(app)/new/pick/machine.tsx
- sources/app/(app)/new/pick/path.tsx (already deleted by feature branch merge)

## Current Merge State (DO NOT LOSE)

The working directory currently has 5 unmerged files. DO NOT run `git reset --hard` or `git merge --abort` until conflicts are properly resolved and committed.

## Next Action

Manually resolve AgentInput.tsx conflict by reading both versions and carefully editing.
