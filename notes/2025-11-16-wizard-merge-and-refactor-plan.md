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

## Design Requirements (User Specifications)

### UI Design Style
- **Settings Panel Style:** Single scrollable page like settings/profiles.tsx
- **Sessions Panel Style:** Prompt field at bottom like session message interface
- **Send Button Behavior:** Arrow button greyed out until all required fields valid

### Layout Structure (Per User Requirements)

**Key Requirements:**
- "wizard to appear in the same main panel as the message interface with the ai agent"
- "create button that gets enabled and the prompt field should use the same 'screen' or 'field' or sub-window as the session prompt"
- "arrow button can be greyed out until it is ready"
- "first pane should be existing profile selection with the ability to create and remove profiles"
- "keep the wizard short, ideally just one step where contents are on one page much like it is in the settings panel"

```
┌──────────────────────────────────────────────┐
│ WIZARD CONFIGURATION (Settings Panel Style)  │
│                                              │
│ 1. Profile Selection (FIRST - required)     │
│    ┌────────────┐ ┌────────────┐            │
│    │ Anthropic  │ │  DeepSeek  │            │
│    │ (selected) │ │            │            │
│    └────────────┘ └────────────┘            │
│    ┌────────────┐ ┌────────────┐            │
│    │   Z.AI     │ │ + Create   │            │
│    │            │ │   Custom   │            │
│    └────────────┘ └────────────┘            │
│    [Edit] [Delete] buttons on selected      │
│                                              │
│ 2. Machine Selection                        │
│    ○ Machine 1 (MacBook Pro)                │
│    ● Machine 2 (Server) ← selected          │
│                                              │
│ 3. Working Directory                        │
│    [/Users/name/projects/app___________]    │
│    Recent: /Users/name/projects/app         │
│           /Users/name/Documents             │
│                                              │
│ 4. Advanced Options (Collapsed ▶)           │
│    [Click to expand session type, perms]    │
│                                              │
├──────────────────────────────────────────────┤
│ PROMPT & CREATE (REUSE AgentInput)          │
│                                              │
│ <AgentInput                                  │
│   value={sessionPrompt}                     │
│   onChangeText={setSessionPrompt}           │
│   onSend={handleCreateSession}              │
│   isSendDisabled={!canCreate}               │
│   isSending={isCreating}                    │
│   placeholder="What would you like..."      │
│   sendIcon={<Ionicons name="arrow-forward"/>}│
│ />                                           │
│                                              │
│ ↑ ACTUAL AgentInput component from sessions │
│ ↑ Arrow button greyed when !canCreate       │
│ ↑ Arrow button enabled when canCreate=true  │
└──────────────────────────────────────────────┘
```

**CRITICAL: REUSE AgentInput Component**
- **DO NOT** create new TextInput + Button
- **DO** use existing `<AgentInput/>` from sources/components/AgentInput.tsx
- **Benefits:** Gets autocomplete, file attachments, all features for free
- **Integration:** Wire validation via `isSendDisabled={!canCreate}` prop

**Profile Details Must Include:**
- Profile name and description
- API configuration (baseUrl, authToken, model)
- Environment variables editor (key-value pairs)
- Tmux configuration (sessionName, tmpDir, updateEnvironment)
- Compatibility flags (Claude/Codex)
- Built-in vs custom profile indicator

### Validation Requirements
- **Create button disabled when:**
  - No profile selected
  - No machine selected
  - No path entered
  - Profile incompatible with agent

- **Create button enabled when:**
  - All required fields valid
  - Show enabled state (not greyed)

### Feature Preservation Requirements
**MUST KEEP:**
- All profile management (create/edit/delete)
- All environment variable handling
- Machine/path selection
- Advanced options (worktree, permission mode, model mode)
- CLI daemon integration
- Profile sync with settings panel

**MUST REMOVE:**
- Multi-step navigation (welcome → ai-backend → session-details → creating)
- Module-level callbacks (onMachineSelected, onPathSelected)
- Picker screen navigation (new/pick/machine.tsx, new/pick/path.tsx)
- Step state machine logic

### Code Quality Requirements
- **DRY:** Extract shared profile utilities to profileUtils.ts
- **KISS:** Keep it simple - inline selectors instead of navigation
- **No Regressions:** Test everything works after refactor
- **Clean Commits:** Follow CLAUDE.md commit message format

## Merge Status

✅ **COMPLETED** at commit `82c4617`
- Proper merge commit with two parents preserved
- Denys Vitali credited in git history
- All conflicts manually resolved
- No conflict markers in source files

## Implementation Checklist

### Phase 1: Preparation
- [x] Merge feature branch into fix branch
- [x] Restore path.tsx (was mistakenly deleted)
- [x] Document design requirements in this file
- [x] Read AgentInput props interface
- [ ] Read complete new/index.tsx wizard structure
- [ ] Map all 4 steps and their content (welcome, ai-backend, session-details, creating)

### Phase 2: Extract Shared Code (DRY)
- [ ] Create sources/sync/profileUtils.ts
- [ ] Move DEFAULT_PROFILES constant to profileUtils.ts
- [ ] Move getBuiltInProfile() function to profileUtils.ts
- [ ] Export both from profileUtils.ts
- [ ] Update new/index.tsx: Import from profileUtils
- [ ] Update settings/profiles.tsx: Import from profileUtils
- [ ] Test: Verify build still compiles

### Phase 3: Remove Multi-Step Navigation
- [ ] Line 27: Delete `type WizardStep = ...`
- [ ] Lines 30-40: Delete module-level callbacks
- [ ] Line 481: Delete `const [currentStep, setCurrentStep] = ...`
- [ ] Lines 569-601: Delete goToNextStep() function
- [ ] Lines 588-612: Delete goToPreviousStep() function
- [ ] Lines 673-681: Delete handleMachineClick and handlePathClick
- [ ] Lines 784-1022: Delete renderStepContent() function
- [ ] Line 1041: Delete call to renderStepContent()

### Phase 4: Build Single-Page Layout
- [ ] Import AgentInput component at top
- [ ] Create single ScrollView in return statement
- [ ] Section 1: Add profile grid (from welcome step lines 800-835)
- [ ] Section 1: Add "Create New Profile" button (from ai-backend step)
- [ ] Section 1: Keep profile edit/delete handlers
- [ ] Section 2: Add machine selector (button that opens picker, show current selection)
- [ ] Section 3: Add path selector (button that opens picker, show current selection)
- [ ] Section 4: Add collapsible advanced options
  - [ ] SessionTypeSelector (if experiments enabled)
  - [ ] Permission mode (could add PermissionModeSelector)
  - [ ] Model mode (could add selector)
- [ ] Section 5: Add AgentInput component with props:
  - [ ] value={sessionPrompt}
  - [ ] onChangeText={setSessionPrompt}
  - [ ] onSend={handleCreateSession}
  - [ ] isSendDisabled={!canCreate}
  - [ ] isSending={isCreating}
  - [ ] placeholder={t('newSession.prompt.placeholder')}
  - [ ] autocompletePrefixes={[]}
  - [ ] autocompleteSuggestions={async () => []}
  - [ ] agentType={agentType}
  - [ ] permissionMode={permissionMode}
  - [ ] modelMode={modelMode}
  - [ ] machineName={selectedMachine?.metadata?.displayName}
  - [ ] currentPath={selectedPath}

### Phase 5: Update Validation Logic
- [ ] Update canCreate useMemo to check:
  - [ ] selectedProfileId !== null (or allow null for manual config)
  - [ ] selectedMachineId !== null
  - [ ] selectedPath.trim() !== ''
  - [ ] Profile compatible with agent
- [ ] Remove validation from goToNextStep (deleted)
- [ ] Keep validation in handleCreateSession

### Phase 6: Test Thoroughly
- [ ] Stop dev server
- [ ] Clear Metro cache
- [ ] Restart dev server
- [ ] Build compiles without errors
- [ ] New session button visible on home
- [ ] Click new session - wizard appears
- [ ] Wizard is single scrollable page (not steps)
- [ ] Profile cards render correctly
- [ ] Profile selection works
- [ ] Machine picker button works
- [ ] Path picker button works
- [ ] Advanced section expands/collapses
- [ ] AgentInput appears at bottom
- [ ] Arrow button greyed when fields missing
- [ ] Arrow button active when fields valid
- [ ] Type in prompt field works
- [ ] Create session works
- [ ] Session receives profile env vars

### Phase 7: Clean Up & Commit
- [ ] Update _layout.tsx if needed (verify picker routes present)
- [ ] Review complete git diff
- [ ] Write CLAUDE.md-compliant commit message
- [ ] Commit refactor
- [ ] Update this plan file with completion notes

## Current Status

- [x] Merge completed at commit `80f425a`
- [x] Plan file updated with accurate design requirements
- [ ] Single-page refactor in progress
