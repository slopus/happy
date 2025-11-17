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
- **Environment variables editor with variable substitution support:**
  - Key-value pairs (e.g., `ANTHROPIC_AUTH_TOKEN` = `${Z_AI_AUTH_TOKEN}`)
  - Support literal values (e.g., `API_TIMEOUT_MS` = `600000`)
  - Support variable references (e.g., `${DEEPSEEK_AUTH_TOKEN}`)
  - Variables can reference:
    - Other env vars on target machine CLI
    - Other env vars set in GUI
    - Literal string values
- Tmux configuration (sessionName, tmpDir, updateEnvironment)
- Compatibility flags (Claude/Codex)
- Built-in vs custom profile indicator

**Environment Variable Examples (from user):**
```bash
# Anthropic (unset all, use defaults)
alias ac='unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL; claude'

# Z.AI (use Z.AI credentials via variable substitution)
alias zc='ANTHROPIC_BASE_URL=${Z_AI_BASE_URL}
          ANTHROPIC_AUTH_TOKEN=${Z_AI_AUTH_TOKEN}
          ANTHROPIC_MODEL=${Z_AI_MODEL} claude'

# DeepSeek (use DeepSeek credentials + config via substitution)
alias dc='ANTHROPIC_BASE_URL=${DEEPSEEK_BASE_URL}
          ANTHROPIC_AUTH_TOKEN=${DEEPSEEK_AUTH_TOKEN}
          API_TIMEOUT_MS=${DEEPSEEK_API_TIMEOUT_MS}
          ANTHROPIC_MODEL=${DEEPSEEK_MODEL}
          ANTHROPIC_SMALL_FAST_MODEL=${DEEPSEEK_SMALL_FAST_MODEL}
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC} claude'
```

**Profile Environment Variable Design:**
- Each profile stores environmentVariables array: `{ name: string, value: string }[]`
- Values can be literals: `"600000"` or variable refs: `"${DEEPSEEK_API_KEY}"`
- Variable substitution happens on target machine (daemon/CLI side)
- GUI just stores the template, daemon resolves variables

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
- [x] Read complete new/index.tsx wizard structure
- [x] Map all 4 steps and their content (welcome, ai-backend, session-details, creating)

### Phase 2: Extract Shared Code (DRY)
- [x] Create sources/sync/profileUtils.ts
- [x] Move DEFAULT_PROFILES constant to profileUtils.ts
- [x] Move getBuiltInProfile() function to profileUtils.ts
- [x] Export both from profileUtils.ts
- [x] Update new/index.tsx: Import from profileUtils
- [x] Update settings/profiles.tsx: Import from profileUtils
- [x] Test: Verify build still compiles

### Phase 3: Remove Multi-Step Navigation (NOT Picker Navigation!)
- [x] Line 27: Delete `type WizardStep = ...`
- [x] Lines 30-40: **KEEP** module-level callbacks (needed for pickers) ✅ KEPT
- [x] Line 481: Delete `const [currentStep, setCurrentStep] = ...`
- [x] Lines 569-601: Delete goToNextStep() function
- [x] Lines 588-612: Delete goToPreviousStep() function
- [x] Lines 673-681: **KEEP** handleMachineClick and handlePathClick (open pickers) ✅ KEPT
- [x] Lines 647-671: **KEEP** useEffect hooks (wire callbacks for pickers) ✅ KEPT
- [x] Lines 784-1022: Delete renderStepContent() function
- [x] Line 1041: Delete call to renderStepContent()

### Phase 4: Build Single-Page Layout
- [x] Import AgentInput component at top
- [x] Create single ScrollView in return statement
- [x] Section 1: Add profile grid (from welcome step lines 800-835)
- [x] Section 1: Add "Create New Profile" button (from ai-backend step) ✅ Added "Manage Profiles" navigation
- [x] Section 1: Keep profile edit/delete handlers ✅ Handled in Settings panel via navigation
- [x] Section 2: Add machine selector (button that opens picker, show current selection)
- [x] Section 3: Add path selector (button that opens picker, show current selection)
- [x] Section 4: Add collapsible advanced options
  - [x] SessionTypeSelector (if experiments enabled)
  - [x] Permission mode (could add PermissionModeSelector) ✅ Passed via AgentInput props
  - [x] Model mode (could add selector) ✅ Passed via AgentInput props
- [x] Section 5: Add AgentInput component with props:
  - [x] value={sessionPrompt}
  - [x] onChangeText={setSessionPrompt}
  - [x] onSend={handleCreateSession}
  - [x] isSendDisabled={!canCreate}
  - [x] isSending={isCreating}
  - [x] placeholder={t('newSession.prompt.placeholder')} ✅ Used hardcoded placeholder
  - [x] autocompletePrefixes={[]}
  - [x] autocompleteSuggestions={async () => []}
  - [x] agentType={agentType}
  - [x] permissionMode={permissionMode}
  - [x] modelMode={modelMode}
  - [x] machineName={selectedMachine?.metadata?.displayName}
  - [x] currentPath={selectedPath}

### Phase 5: Update Validation Logic
- [x] Update canCreate useMemo to check:
  - [x] selectedProfileId !== null (or allow null for manual config)
  - [x] selectedMachineId !== null
  - [x] selectedPath.trim() !== ''
  - [x] Profile compatible with agent ✅ Via compatibleProfiles filter
- [x] Remove validation from goToNextStep (deleted)
- [x] Keep validation in handleCreateSession

### Phase 6: Test Thoroughly
- [x] Stop dev server
- [x] Clear Metro cache
- [x] Restart dev server
- [x] Build compiles without errors
- [ ] New session button visible on home ⏳ Needs manual testing
- [ ] Click new session - wizard appears ⏳ Needs manual testing
- [ ] Wizard is single scrollable page (not steps) ⏳ Needs manual testing
- [ ] Profile cards render correctly ⏳ Needs manual testing
- [ ] Profile selection works ⏳ Needs manual testing
- [ ] Machine picker button works ⏳ Needs manual testing
- [ ] Path picker button works ⏳ Needs manual testing
- [ ] Advanced section expands/collapses ⏳ Needs manual testing
- [ ] AgentInput appears at bottom ⏳ Needs manual testing
- [ ] Arrow button greyed when fields missing ⏳ Needs manual testing
- [ ] Arrow button active when fields valid ⏳ Needs manual testing
- [ ] Type in prompt field works ⏳ Needs manual testing
- [ ] Create session works ⏳ Needs manual testing
- [ ] Session receives profile env vars ⏳ Needs manual testing

### Phase 7: Clean Up & Commit
- [x] Update _layout.tsx if needed (verify picker routes present) ✅ Added path route
- [x] Review complete git diff
- [x] Write CLAUDE.md-compliant commit message
- [x] Commit refactor
- [x] Update this plan file with completion notes

## Critical Implementation Details

### AgentInput Component (THE Session Panel Prompt Field)
**Location:** `sources/components/AgentInput.tsx`
**Used In:** `sources/-session/SessionView.tsx:276` (actual session panel)
**Interface:** Lines 27-71 define AgentInputProps

**Required Props:**
```typescript
value: string                    // sessionPrompt state
onChangeText: (text) => void    // setSessionPrompt
onSend: () => void              // handleCreateSession
placeholder: string              // "What would you like to work on?"
autocompletePrefixes: string[]   // [] for wizard (no autocomplete needed)
autocompleteSuggestions: async  // async () => [] (empty for wizard)
```

**Validation Props:**
```typescript
isSendDisabled?: boolean        // Wire to !canCreate
isSending?: boolean             // Wire to isCreating
```

**Optional Context Props (Useful):**
```typescript
agentType?: 'claude' | 'codex'  // Show agent indicator
permissionMode?: PermissionMode  // Show permission badge
modelMode?: ModelMode            // Show model info
machineName?: string | null      // Show machine name
currentPath?: string | null      // Show current path
```

### Current Wizard Structure (sources/app/(app)/new/index.tsx)

**Lines to DELETE:**
- Line 27: `type WizardStep = 'welcome' | 'ai-backend' | 'session-details' | 'creating';`
- Lines 30-40: Module-level callbacks (onMachineSelected, onPathSelected, callbacks export)
- Line 481: `const [currentStep, setCurrentStep] = useState<WizardStep>('welcome');`
- Lines 569-601: `goToNextStep()` - handles step transitions
- Lines 588-612: `goToPreviousStep()` - handles back navigation
- Lines 673-681: `handleMachineClick()` and `handlePathClick()` - picker navigation
- Lines 784-1022: `renderStepContent()` - switch statement rendering steps
- Line 1041: `{renderStepContent()}` - call to render function

**Content to EXTRACT and INLINE:**

**Step 1 'welcome' (lines 788-857):**
- Profile grid cards (lines 800-835)
- compatibleProfiles.map() rendering
- selectProfile() handler (line 808)
- Profile badges (Claude/Codex/Built-in)
- "Create New" button (line 841) → goes to ai-backend step

**Step 2 'ai-backend' (lines 860-918):**
- Create new profile form (lines 873-896)
- newProfileName and newProfileDescription inputs
- createNewProfile() handler (line 616, called from Next button)
- **BECOMES:** Profile edit modal (like settings/profiles.tsx:481-989 ProfileEditForm)
- **MUST ADD:** Full profile editor with:
  - Profile name (required)
  - Base URL (optional)
  - Auth token (optional, secureTextEntry)
  - Model (optional)
  - Tmux session name (optional)
  - Tmux temp dir (optional)
  - Tmux update environment (checkbox)
  - Custom environment variables (key-value pairs with add/remove)
- **REFERENCE:** settings/profiles.tsx:481-989 for complete implementation

**Step 3 'session-details' (lines 920-994):**
- Prompt TextInput (lines 934-945) → REPLACE with AgentInput
- Machine button (lines 947-954) → Keep as button, opens picker
- Path button (lines 956-963) → Keep as button, opens picker
- SessionTypeSelector (lines 965-972) → Move to advanced section
- Create button (lines 982-991) → REMOVE (AgentInput has send button)

**Step 4 'creating' (lines 996-1017):**
- Loading spinner → REMOVE (AgentInput isSending handles this)

**Functions to KEEP:**
- Line 603: `selectProfile()` - auto-select agent based on profile
- Line 616: `createNewProfile()` - add profile to settings
- Lines 647-671: useEffect hooks for machine/path callbacks → **KEEP** (needed for pickers)
- Lines 673-681: handleMachineClick(), handlePathClick() → **KEEP** (open pickers)
- Lines 684-779: `handleCreateSession()` - KEEP, wire to AgentInput.onSend
- **MISSING:** Need profile edit/delete handlers (check settings/profiles.tsx for reference)

**State to KEEP:**
- Lines 462-469: Settings hooks (recentMachinePaths, lastUsedAgent, etc.)
- Lines 473-475: allProfiles useMemo
- Line 477: profileMap
- Line 478: machines
- Lines 481-523: All wizard state (profile, agent, machine, path, prompt, etc.)
- Lines 552-566: Computed values (compatibleProfiles, selectedProfile, selectedMachine)

**NEW State to ADD:**
```typescript
const [showAdvanced, setShowAdvanced] = useState(false); // For collapsible section
```

### Picker Screens (KEEP - Provide Valuable UX)

**sources/app/(app)/new/pick/machine.tsx:**
- Machine selection with list
- Uses callbacks.onMachineSelected() (line 30 in new/index.tsx)
- Navigation route: `/new/pick/machine`

**sources/app/(app)/new/pick/path.tsx:**
- Recent paths display
- Common directories (Home, Projects, Documents, Desktop)
- Custom path input
- Uses callbacks.onPathSelected() (line 31 in new/index.tsx)
- Navigation route: `/new/pick/path?machineId=${selectedMachineId}`
- **IMPORTANT:** Restored in merge (was mistakenly deleted by feature branch)

**Decision:** Keep pickers but update wizard to show current selection inline
- Show machine/path as Pressable buttons
- Clicking opens picker screen
- Picker uses callback to return selection
- Main wizard shows updated selection

### Profile Utilities Extraction (DRY)

**Current Duplication:**
- new/index.tsx lines 43-153: DEFAULT_PROFILES + getBuiltInProfile()
- settings/profiles.tsx lines 27-100: Same code duplicated
- AgentInput.tsx: NO LONGER HAS THIS (feature branch cleaned it up)

**Solution:**
Create `sources/sync/profileUtils.ts`:
```typescript
export const DEFAULT_PROFILES = [...]; // From new/index.tsx lines 156-187
export const getBuiltInProfile = (id: string): AIBackendProfile | null => {
  // From new/index.tsx lines 43-153
};
```

Then import in both files:
```typescript
import { getBuiltInProfile, DEFAULT_PROFILES } from '@/sync/profileUtils';
```

### Validation Logic

**Current (lines 685-692 in handleCreateSession):**
```typescript
if (!selectedMachineId) {
    Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
    return;
}
if (!selectedPath) {
    Modal.alert(t('common.error'), t('newSession.noPathSelected'));
    return;
}
if (!sessionPrompt.trim()) {
    Modal.alert('Error', 'Please enter a prompt for the session');
    return;
}
```

**NEW canCreate Validation:**
```typescript
const canCreate = useMemo(() => {
  return (
    selectedProfileId !== undefined &&  // Allow null for manual config
    selectedMachineId !== null &&
    selectedPath.trim() !== ''
    // Note: sessionPrompt is OPTIONAL (can create without initial message)
  );
}, [selectedProfileId, selectedMachineId, selectedPath]);
```

**Wire to AgentInput:**
```typescript
<AgentInput
  isSendDisabled={!canCreate}
  isSending={isCreating}
  onSend={handleCreateSession}
  ...
/>
```

### handleCreateSession Changes

**Current:** Lines 684-779, expects sessionPrompt from state
**CORRECTION:** AgentInput is a CONTROLLED component (not self-managing)
**Integration:**
```typescript
// Wizard provides state:
const [sessionPrompt, setSessionPrompt] = useState('');

// AgentInput is controlled:
<AgentInput
  value={sessionPrompt}           // Controlled value
  onChangeText={setSessionPrompt} // Updates state
  onSend={handleCreateSession}    // Calls handler
/>

// handleCreateSession reads from sessionPrompt state (no changes needed)
```

### Layout.tsx Picker Routes

**Location:** `sources/app/(app)/_layout.tsx`

**Verify These Exist:**
```typescript
<Stack.Screen
  name="new/pick/machine"  // Line ~301
  options={{...}}
/>
<Stack.Screen
  name="new/pick/path"     // Line ~307
  options={{...}}
/>
```

**Action:** Check after merge - may have been removed, need to restore

## End-to-End Workflow

### User Flow (After Refactor)

1. **User clicks "New Session" button** → Navigates to `/new/index`
2. **Wizard appears as single scrollable page** (not modal overlay - fixed in commit 0abfc20)
3. **User sees all sections at once:**
   - Profile grid at top (auto-selected: Anthropic default)
   - Machine selector below (auto-selected: first/recent machine)
   - Path input below (auto-populated: recent path for machine)
   - Advanced options collapsed
   - AgentInput at bottom with greyed arrow button

4. **User can interact with any section:**
   - Click different profile → Highlights, updates agent type if exclusive
   - Click "Create Custom" → Opens full profile edit modal
   - Click "Edit" on profile → Opens profile editor with all fields
   - Click machine → Either inline select OR opens picker
   - Click path → Either inline edit OR opens picker with recent paths
   - Expand advanced → Shows SessionTypeSelector, permission/model modes
   - Type in AgentInput → Prompt text appears

5. **Validation feedback:**
   - If profile missing → Arrow button greyed, AgentInput shows disabled state
   - If machine missing → Arrow button greyed
   - If path empty → Arrow button greyed
   - When all required fields valid → Arrow button becomes active/enabled

6. **User clicks arrow button:**
   - Calls handleCreateSession() (lines 684-779)
   - Creates session with profile environment variables
   - Navigates to `/session/${sessionId}`

### Critical Workflow Details

**Profile Creation/Edit Workflow:**
```
User clicks "Create Custom" or "Edit" on profile card
  ↓
Modal appears with ProfileEditForm (based on settings/profiles.tsx:481-989)
  ↓
User fills: name, baseURL, authToken, model, tmux config, env vars
  ↓
User clicks Save
  ↓
handleSaveProfile() adds/updates in profiles array
  ↓
sync.applySettings({ profiles: updatedProfiles })
  ↓
Profile appears in grid, syncs with settings panel
```

**Session Creation Workflow:**
```
User fills wizard fields (profile, machine, path, optional prompt)
  ↓
All required fields valid → canCreate = true → Arrow enabled
  ↓
User types optional prompt in AgentInput
  ↓
User clicks arrow button (or presses Enter)
  ↓
handleCreateSession() called
  ↓
Gets environmentVariables from selectedProfile (line 737)
  ↓
transformProfileToEnvironmentVars() filters by agent type (lines 198-237)
  ↓
machineSpawnNewSession() with environmentVariables
  ↓
Session created, receives correct env vars
  ↓
Optional: sendMessage() if prompt provided (line 755)
  ↓
Navigate to session view
```

**Picker Integration Workflow:**
```
User clicks machine button
  ↓
handleMachineClick() calls router.push('/new/pick/machine')
  ↓
Picker screen opens (machine.tsx)
  ↓
User selects machine
  ↓
callbacks.onMachineSelected(machineId) called
  ↓
useEffect hook (lines 647-661) receives callback
  ↓
Updates selectedMachineId and auto-updates selectedPath
  ↓
Router.back() returns to wizard
  ↓
Wizard shows updated machine/path selection
```

## Current Status

- [x] Merge completed at commit `b618935`
- [x] Plan file updated with all actionable details
- [x] Single-page refactor COMPLETED

## Refactor Completion Summary

### Final Commit Count: **21 GUI commits + 2 CLI commits = 23 total**

### Core Refactor Commits (1-9):
1. **`611615a`** - Extract profileUtils.ts (DRY refactor, -221 lines duplication)
2. **`5e50122`** - Convert to single-page wizard with AgentInput integration (-262 lines)
3. **`5811488`** - Fix missing path picker route in _layout.tsx
4. **`a3092c3`** - Add 'Manage Profiles' button to navigate to settings panel (later superseded)
5. **`6096cd2`** - Mark wizard refactor as completed in plan file
6. **`fe3ab27`** - Mark all implementation checkboxes as completed in plan
7. **`bbdaa0d`** - Add Phase 8 CLI/GUI compatibility verification checklist
8. **`b151abc`** - **CRITICAL FIX**: Remove restrictive env var filtering that dropped custom variables
9. **`b072da8`** - Fix selectedPath parameter passing to path picker

### Profile Management Integration (10-12):
10. **`5ae08d1`** - Integrate complete profile management into wizard (DRY with settings)
    - Created sources/components/ProfileEditForm.tsx (+525 lines)
    - Created sources/app/(app)/new/pick/profile-edit.tsx (+63 lines)
    - Replaced grid with settings-style list UI
    - Added Edit/Delete/Duplicate handlers
    - Settings panel now uses shared ProfileEditForm (-513 lines)
11. **`84d1f1f`** - Profile persistence + PermissionModeSelector
    - Changed to useSettingMutable for persistence
    - Added PermissionModeSelector to advanced options
12. **`ee07268`** - Profile-level permission mode with UI in editor and wizard
    - Added defaultPermissionMode to schema
    - Permission mode moved to Section 4 (main UI)

### Permission Mode UI Evolution (13-17):
13. **`739d673`** - Add 4-button permission mode grid UI (superseded by ItemGroup pattern)
14. **`91f129c`** - **Use ItemGroup/Item pattern** for permission mode (matches Denys design)
15. **`4a00568`** - White checkmarks and border for permission mode selection
16. **`5718c99`** - White border ONLY on selected item (not whole group)

### Session Type Integration (18-19):
17. **`fc4981e`** - Add session type to profiles with auto-selection
    - Added defaultSessionType to schema
    - Session type in ProfileEditForm
    - Auto-set when selecting profile

### Profile Action Buttons (20):
18. **`f155718`** - Add Duplicate/Delete profile buttons below profile list

### CLI Schema Updates (21-22):
19. **`ae666e2`** (CLI) - Add defaultPermissionMode and defaultModelMode to schema
20. **`842bb9f`** (CLI) - Add defaultSessionType to schema

### Implementation Details:
- ✅ Removed multi-step navigation (4 steps → single page)
- ✅ Integrated AgentInput component from session panel
- ✅ Complete profile management in wizard (Add/Edit/Duplicate/Delete)
- ✅ Profile editor as separate screen (new/pick/profile-edit.tsx)
- ✅ Session type, permission mode, model mode saved in profiles
- ✅ Auto-configuration: Selecting profile sets session type, permission mode
- ✅ Validation via canCreate → isSendDisabled prop
- ✅ Prompt optional (can create session without initial message)
- ✅ File size reduced: 904 lines → final implementation
- ✅ CLI/GUI schemas match exactly (AIBackendProfile)

### Testing Status:
- ✅ Build compiles successfully (exit code 0, 2838 modules)
- ✅ Mac desktop app launched via tauri:dev
- ✅ Hot reload working
- ⏳ Manual testing in progress

### Notes:
- Profile management fully integrated into wizard (Settings panel still exists but uses shared component)
- ProfileEditForm extracted to sources/components/ProfileEditForm.tsx (DRY)
- Picker screens kept for better UX (machine.tsx, path.tsx, profile-edit.tsx)
- AgentInput reused from session panel (consistent UX)
- Permission mode uses ItemGroup/Item pattern (matches Denys' wizard design)
- White styling matches profile selection UI

## Technical Implementation Details (CLAUDE.md Concrete)

### Key Files and Objects

#### 1. AIBackendProfile Schema (CLI and GUI - EXACT MATCH)
**Location:**
- GUI: `sources/sync/settings.ts:51-84`
- CLI: `src/persistence.ts:64-97`

**Properties:**
```typescript
{
    id: string (UUID)
    name: string (1-100 chars)
    description?: string (max 500 chars)
    anthropicConfig?: { baseUrl?, authToken?, model? }
    openaiConfig?: { apiKey?, baseUrl?, model? }
    azureOpenAIConfig?: { apiKey?, endpoint?, apiVersion?, deploymentName? }
    togetherAIConfig?: { apiKey?, model? }
    tmuxConfig?: { sessionName?, tmpDir?, updateEnvironment? }
    environmentVariables: Array<{ name: string, value: string }>
    defaultSessionType?: 'simple' | 'worktree'          // NEW: Line 69 (GUI), Line 82 (CLI)
    defaultPermissionMode?: string                       // NEW: Line 72 (GUI), Line 85 (CLI)
    defaultModelMode?: string                            // NEW: Line 75 (GUI), Line 88 (CLI)
    compatibility: { claude: boolean, codex: boolean }
    isBuiltIn: boolean
    createdAt: number
    updatedAt: number
    version: string (default '1.0.0')
}
```

#### 2. New Session Wizard (sources/app/(app)/new/index.tsx)
**Total Lines:** 864 (was 904, reduced by 40 lines net)

**Key Functions:**
- `selectProfile(profileId)` (lines 373-392): Auto-sets agent, session type, permission mode from profile
- `handleAddProfile()` (lines 394-399): Creates empty profile, navigates to editor
- `handleEditProfile(profile)` (lines 401-404): Opens editor with profile data
- `handleDuplicateProfile(profile)` (lines 406-414): Creates copy with "(Copy)" suffix
- `handleDeleteProfile(profile)` (lines 416-431): Shows confirmation, deletes profile
- `handleCreateSession()` (lines 487-587): Creates session with profile env vars

**Callbacks (lines 29-43):**
```typescript
onMachineSelected: (machineId: string) => void
onPathSelected: (path: string) => void
onProfileSaved: (profile: AIBackendProfile) => void
```

**State Management:**
- `profiles` via `useSettingMutable('profiles')` (line 232) - enables persistence
- `selectedProfileId` (line 243) - defaults to 'anthropic'
- `permissionMode` (line 257) - set from profile.defaultPermissionMode
- `sessionType` (line 256) - set from profile.defaultSessionType

**UI Sections:**
1. **Profile Management** (lines 623-764):
   - Built-in profiles list (lines 630-669): star icon, Edit button
   - Custom profiles list (lines 671-729): person icon, Edit/Duplicate/Delete buttons
   - Action buttons (lines 732-764): Add/Duplicate/Delete row
2. **Machine Selection** (lines 766-776): Opens /new/pick/machine
3. **Working Directory** (lines 778-789): Opens /new/pick/path with selectedPath param
4. **Permission Mode** (lines 791-829): ItemGroup with 4 items, white border on selected
5. **Advanced Options** (lines 831-854): SessionTypeSelector (if experiments enabled)
6. **AgentInput** (lines 856-871): Validation via isSendDisabled={!canCreate}

#### 3. ProfileEditForm Component (sources/components/ProfileEditForm.tsx)
**Total Lines:** 549

**Props Interface (lines 12-16):**
```typescript
{
    profile: AIBackendProfile
    onSave: (profile: AIBackendProfile) => void
    onCancel: () => void
}
```

**State (lines 23-37):**
- Form fields: name, baseUrl, authToken, model
- Tmux fields: tmuxSession, tmuxTmpDir, tmuxUpdateEnvironment
- Profile defaults: defaultSessionType, defaultPermissionMode
- Custom env vars: Record<string, string>

**UI Sections:**
- Profile Name (lines 140-156)
- Base URL (lines 158-176, optional)
- Auth Token (lines 178-197, secureTextEntry)
- Model (lines 199-220, optional)
- Session Type (lines 244-259): SessionTypeSelector component
- Permission Mode (lines 271-308): ItemGroup with 4 items
- Tmux config (lines 310-345)
- Custom environment variables (lines 347-439): Add/remove key-value pairs
- Cancel/Save buttons (lines 441-483)

**Save Logic (lines 68-100):**
- Converts customEnvVars Record → environmentVariables array
- Saves defaultSessionType, defaultPermissionMode
- Updates updatedAt timestamp

#### 4. Profile Edit Picker Screen (sources/app/(app)/new/pick/profile-edit.tsx)
**Total Lines:** 63

**Functionality:**
- Receives profile via URL param `profileData` (JSON.stringify + encodeURIComponent)
- Deserializes profile (lines 14-34)
- Renders ProfileEditForm as full screen (lines 49-59)
- Calls `callbacks.onProfileSaved()` on save (line 38)
- Navigates back with router.back() (lines 39, 43)

#### 5. Profile Utilities (sources/sync/profileUtils.ts)
**Total Lines:** 157

**Exports:**
- `getBuiltInProfile(id)` (lines 10-120): Returns profile config for 6 providers
- `DEFAULT_PROFILES` (lines 126-157): Array of built-in profile metadata

**Built-in Profiles:**
1. Anthropic (default, empty config)
2. DeepSeek (baseUrl, model, 6 env vars)
3. Z.AI (baseUrl, model)
4. OpenAI (GPT-5 config, 4 env vars)
5. Azure OpenAI (deployment config, 2 env vars)
6. Together AI (baseUrl, model, 2 env vars)

#### 6. Key Data Flows

**Profile Selection → Auto-configuration:**
```
User clicks profile
  ↓
selectProfile(profileId) called (new/index.tsx:373)
  ↓
Get profile from profileMap (line 375)
  ↓
Set agentType if exclusive compatibility (lines 378-382)
  ↓
Set sessionType from profile.defaultSessionType (lines 384-386)
  ↓
Set permissionMode from profile.defaultPermissionMode (lines 388-390)
  ↓
Wizard UI updates to show profile's defaults
```

**Profile Save Flow:**
```
User edits profile in profile-edit.tsx
  ↓
Clicks Save → handleSave() called (ProfileEditForm.tsx:68)
  ↓
Validates name.trim() (line 69)
  ↓
Converts customEnvVars Record → environmentVariables array (lines 75-78)
  ↓
Calls onSave() with updated profile (lines 83-100)
  ↓
profile-edit.tsx handleSave() receives profile (line 37)
  ↓
Calls callbacks.onProfileSaved(savedProfile) (line 38)
  ↓
new/index.tsx useEffect hook receives (lines 468-489)
  ↓
Updates profiles array, calls setProfiles() (line 482)
  ↓
Profile persisted via useSettingMutable
  ↓
Sets selectedProfileId to saved profile (line 483)
  ↓
router.back() returns to wizard (profile-edit.tsx:39)
```

**Session Creation with Profile Env Vars:**
```
User fills wizard, clicks AgentInput arrow
  ↓
handleCreateSession() called (new/index.tsx:487)
  ↓
Get selectedProfile from profileMap (line 539)
  ↓
transformProfileToEnvironmentVars(profile, agentType) (line 540)
  ↓
getProfileEnvironmentVariables(profile) returns ALL env vars (line 51-54)
  ↓
machineSpawnNewSession({ environmentVariables }) (lines 546-553)
  ↓
RPC sends Record<string, string> to daemon (ops.ts:165-176)
  ↓
Daemon receives options.environmentVariables (daemon/run.ts:296)
  ↓
Merges with authEnv, passes to process.env (line 326)
  ↓
Agent process receives complete environment
```

### Critical Bug Fixes

**BUG 1: Environment Variable Filtering (commit b151abc)**
- **Problem:** `transformProfileToEnvironmentVars()` had whitelist filter (new/index.tsx:50-89)
- **Impact:** Dropped custom vars like DEEPSEEK_API_TIMEOUT_MS, DEEPSEEK_SMALL_FAST_MODEL
- **Fix:** Removed filter, now passes ALL vars from getProfileEnvironmentVariables()
- **Files:** new/index.tsx (simplified to 5 lines), ops.ts (type changed to Record<string, string>)

**BUG 2: Path Picker Memory (commit b072da8)**
- **Problem:** handlePathClick() only passed machineId, not selectedPath
- **Impact:** Path picker couldn't highlight current selection
- **Fix:** Added selectedPath URL param with encodeURIComponent (line 370)
- **Files:** new/index.tsx handlePathClick()

**BUG 3: Profile Persistence (commit 84d1f1f)**
- **Problem:** Used useSetting (read-only) instead of useSettingMutable
- **Impact:** Profile changes not saved between sessions
- **Fix:** Changed to useSettingMutable, used setProfiles() in save handlers
- **Files:** new/index.tsx (line 232, 442, 391)

### Most Important Files

**1. sources/app/(app)/new/index.tsx** (864 lines)
- Complete wizard implementation
- Profile management (Add/Edit/Duplicate/Delete)
- Session creation with profile env vars
- Picker integration (machine, path, profile-edit)

**2. sources/components/ProfileEditForm.tsx** (549 lines)
- Shared profile editor component
- All profile fields (name, URL, token, model, tmux, env vars, session type, permission mode)
- Used by both wizard and settings panel (DRY)

**3. sources/sync/settings.ts** (GUI) and src/persistence.ts** (CLI)
- AIBackendProfile schema definitions (MUST MATCH)
- Schema version: SUPPORTED_SCHEMA_VERSION = 2
- Profile version: CURRENT_PROFILE_VERSION = '1.0.0'

**4. sources/sync/profileUtils.ts** (157 lines)
- Built-in profile definitions (6 providers)
- getBuiltInProfile() function
- DEFAULT_PROFILES constant

**5. sources/app/(app)/new/pick/profile-edit.tsx** (63 lines)
- Profile editor picker screen
- Serializes/deserializes profile via URL params
- Callback integration

### Intended Functionality

**User creates new session:**
1. Opens wizard (single scrollable page, no multi-step navigation)
2. Selects AI profile from list (defaults to Anthropic)
   - Profile auto-sets: agent type, session type, permission mode
3. Selects machine (opens picker, returns selection)
4. Selects/edits path (opens picker with recent paths, returns selection)
5. Reviews/changes permission mode (4 items: Default/Accept Edits/Plan/Bypass Permissions)
6. Optionally expands Advanced Options (worktree toggle if experiments enabled)
7. Types optional prompt in AgentInput
8. Arrow button enabled when profile+machine+path valid (prompt optional)
9. Clicks arrow → session created with profile's environment variables
10. Navigates to session view

**User manages profiles:**
1. Clicks "Edit" on existing profile OR "Add" button → opens profile-edit screen
2. Configures all fields in editor:
   - Name, description
   - API config (baseUrl, authToken, model)
   - Session Type (simple/worktree)
   - Permission Mode (4 options with icons)
   - Tmux config (sessionName, tmpDir, updateEnvironment)
   - Custom environment variables (key-value pairs, supports ${VAR} substitution)
3. Clicks Save → profile persisted via useSettingMutable
4. Returns to wizard → updated profile visible in list
5. For custom profiles: Duplicate creates copy, Delete shows confirmation

**Environment variable flow:**
- GUI stores: `{ name: 'ANTHROPIC_BASE_URL', value: 'https://api.z.ai' }`
- GUI sends to daemon: `{ ANTHROPIC_BASE_URL: 'https://api.z.ai' }`
- Daemon variable substitution: `${Z_AI_AUTH_TOKEN}` → resolved on CLI machine
- Agent receives: Complete environment with ALL custom variables

## Phase 8: CLI/GUI Compatibility Verification

### Schema Compatibility Checks:
- [x] AIBackendProfile schema matches between CLI and GUI (EXACT MATCH in persistence.ts and settings.ts)
- [x] environmentVariables field accepts Record<string, string> in both
- [x] Daemon run.ts accepts GUI-provided environmentVariables (lines 296-328)
- [x] Profile helper functions match (getProfileEnvironmentVariables, validateProfileForAgent)
- [x] Profile versioning system matches (CURRENT_PROFILE_VERSION = '1.0.0')
- [x] Settings schemaVersion matches (SUPPORTED_SCHEMA_VERSION = 2)

### Critical Bug Fixes:
- [x] **BUG**: transformProfileToEnvironmentVars() was filtering to whitelist
  - Problem: Dropped custom DEEPSEEK_*, Z_AI_* variables
  - Fix: Removed filter, now passes ALL vars from getProfileEnvironmentVariables()
  - Commit: b151abc
- [x] **BUG**: ops.ts type only listed 5 env vars (too restrictive)
  - Problem: TypeScript would reject custom variables
  - Fix: Changed to Record<string, string> to match daemon
  - Commit: b151abc

### Data Flow Verification:
- [x] GUI: AIBackendProfile → getProfileEnvironmentVariables() → ALL vars returned
- [x] GUI: transformProfileToEnvironmentVars() → passes ALL vars (no filtering)
- [x] GUI: machineSpawnNewSession() → sends Record<string, string> via RPC
- [x] Server: Forwards environmentVariables to daemon
- [x] CLI Daemon: Receives Record<string, string> in options.environmentVariables
- [x] CLI Daemon: Merges with authEnv, passes to process.env (lines 296-328)
- [x] Agent Process: Receives complete environment with ALL custom vars

### Compatibility Test Cases:
- [ ] Test Anthropic profile (minimal config, no custom vars)
- [ ] Test DeepSeek profile (6 env vars including 3 custom DEEPSEEK_*)
- [ ] Test Z.AI profile (with ${Z_AI_AUTH_TOKEN} substitution)
- [ ] Test custom profile with arbitrary env vars
- [ ] Verify daemon logs show all env vars received
