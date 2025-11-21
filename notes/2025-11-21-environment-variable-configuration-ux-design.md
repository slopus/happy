# Environment Variable Configuration UX Design
**Date:** 2025-11-21
**Branch:** fix/new-session-wizard-ux-improvements
**Status:** 📋 DESIGN SPECIFICATION

## Problem Statement

**Current Issues:**
1. **Read vs Write Ambiguity:** No clear distinction between reading variables from remote daemon environment (`${VAR}`) vs writing literal values
2. **Missing Override Control:** Built-in profiles (Z.AI, DeepSeek) have pre-configured variable mappings but users can't easily customize them
3. **No Visual Feedback:** Users can't see what values are actually set on the remote machine
4. **Confusing Terminology:** "Template", "evaluate", "daemon environment" are unclear jargon
5. **Incomplete CRUD:** Can view variables but no clear UI for add/edit/delete operations

**Root Cause:**
ProfileEditForm shows environment variables as read-only documentation without edit capabilities. The distinction between `${Z_AI_MODEL}` (reads from daemon) and `GLM-4.6` (literal value) is not exposed to users.

## Solution: Checkbox-Based Variable Configuration

### Design Principles

Based on industry research (VSCode, Docker, Kubernetes) and UI/UX best practices:

1. **Simple checkbox mental model** - "Try reading from remote first" is an optional behavior
2. **Always show both fields** - No layout shifting, all information visible
3. **Plain language** - "On machine", "Value found", not technical jargon
4. **Immediate visual feedback** - Show checkmark/X for variable status on remote
5. **Expected value guidance** - Help users know what to set in their shell

### Visual Design Specification

#### **State 1: Variable Found on Remote (Matches Expected)**
```
┌──────────────────────────────────────────────────────────┐
│ ANTHROPIC_MODEL                      [Delete] [Cancel]  │
│ Model that Claude CLI will use                          │
│                                                           │
│ ☑ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │ Z_AI_MODEL                                    │       │
│ └───────────────────────────────────────────────┘       │
│ ✓ Value found: GLM-4.6                                  │
│                                                           │
│ Default value:                                           │
│ ┌───────────────────────────────────────────────┐       │
│ │ GLM-4.6                                       │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ Session will receive: ANTHROPIC_MODEL = GLM-4.6          │
│                                                           │
│ [Save]                                                   │
└──────────────────────────────────────────────────────────┘
```

**Stores:** `{ name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.6}' }`

#### **State 2: Variable Found (Differs from Expected)**
```
│ ☑ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │ Z_AI_MODEL                                    │       │
│ └───────────────────────────────────────────────┘       │
│ ✓ Value found: GLM-4.7-Preview                          │
│ ⚠️ Differs from documented value: GLM-4.6               │
│   (in muted gray - theme.colors.textSecondary)          │
│                                                           │
│ Default value:                                           │
│ ┌───────────────────────────────────────────────┐       │
│ │ GLM-4.6                                       │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ Session will receive: ANTHROPIC_MODEL = GLM-4.7-Preview  │
```

**Stores:** `{ name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.6}' }`

#### **State 3: Variable Not Found on Remote**
```
│ ☑ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │ Z_AI_MODEL                                    │       │
│ └───────────────────────────────────────────────┘       │
│ ✗ Value not found                                        │
│                                                           │
│ Default value:                                           │
│ ┌───────────────────────────────────────────────┐       │
│ │ GLM-4.6                                       │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ Session will receive: ANTHROPIC_MODEL = GLM-4.6          │
│ (will use default value)                                │
```

**Stores:** `{ name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.6}' }`

#### **State 4: Variable Not Found, User Changed Default (Override Warning)**
```
│ ☑ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │ Z_AI_MODEL                                    │       │
│ └───────────────────────────────────────────────┘       │
│ ✗ Value not found                                        │
│                                                           │
│ Default value:                                           │
│ ┌───────────────────────────────────────────────┐       │
│ │ GLM-4.8-Experimental                          │       │
│ └───────────────────────────────────────────────┘       │
│ ⚠️ Overriding documented default: GLM-4.6               │
│   (in muted gray - theme.colors.textSecondary)          │
│                                                           │
│ Session will receive: ANTHROPIC_MODEL = GLM-4.8-Experimental │
```

**Stores:** `{ name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.8-Experimental}' }`

#### **State 5: Checkbox Unchecked (Hardcoded Value)**
```
│ ☐ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │ Z_AI_MODEL                        [disabled]  │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ Default value:                                           │
│ ┌───────────────────────────────────────────────┐       │
│ │ GLM-4.6                                       │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ Session will receive: ANTHROPIC_MODEL = GLM-4.6          │
```

**Stores:** `{ name: 'ANTHROPIC_MODEL', value: 'GLM-4.6' }`

#### **State 6: Unchecked, User Custom Value (Differs Warning)**
```
│ ☐ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │ Z_AI_MODEL                        [disabled]  │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ Default value:                                           │
│ ┌───────────────────────────────────────────────┐       │
│ │ GLM-4.8-Experimental                          │       │
│ └───────────────────────────────────────────────┘       │
│ ⚠️ Differs from documented value: GLM-4.6               │
│   (in muted gray - theme.colors.textSecondary)          │
│                                                           │
│ Session will receive: ANTHROPIC_MODEL = GLM-4.8-Experimental │
```

**Stores:** `{ name: 'ANTHROPIC_MODEL', value: 'GLM-4.8-Experimental' }`

#### **State 7: Loading (Machine Selected, Querying)**
```
│ ☑ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │ Z_AI_MODEL                                    │       │
│ └───────────────────────────────────────────────┘       │
│ ⏳ Checking remote machine...                            │
```

#### **State 8: No Machine Selected**
```
│ ☑ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │ Z_AI_MODEL                                    │       │
│ └───────────────────────────────────────────────┘       │
│ ℹ️ Select a machine to check if variable exists         │
```

### Color Scheme (Existing Theme Variables)

**Status Indicators:**
```typescript
theme.colors.success           // #34C759 (light) / #32D74B (dark) - ✓ Value found (green checkmark)
theme.colors.textSecondary     // #8E8E93 (both modes) - ⚠️ Warnings (muted gray, informational)
theme.colors.warning           // #8E8E93 (gray) - ✗ Value not found (alert-circle icon)
theme.colors.textDestructive   // #FF3B30 (light) / #FF453A (dark) - Mismatches, delete icons, secrets
```

**Note:** `theme.colors.warning` is actually gray (#8E8E93), not orange. For actual value mismatches (differs from expected), the existing code uses `theme.colors.textDestructive` (red) with close-circle icon.

**Text Colors:**
```typescript
theme.colors.text              // #000000 (light) / varies (dark) - Primary text
theme.colors.textSecondary     // #8E8E93 - Secondary text, labels, warnings
theme.colors.button.primary.tint // #FFFFFF - Button text
```

**Background Colors:**
```typescript
theme.colors.input.background  // #F5F5F5 - Input fields
theme.colors.surface           // #ffffff (light) - Container backgrounds
theme.colors.surfacePressed    // #f0f0f2 - Code blocks, pressed states
```

**Typography (Existing Font Sizes in ProfileEditForm):**
```typescript
fontSize: 14  // Main section headers (fontWeight: '600')
fontSize: 13  // Subsection text
fontSize: 12  // Variable names, labels (fontWeight: '600')
fontSize: 11  // Descriptions, status text, expected/actual values
```

**Warning Text Style:**
- Color: `theme.colors.textSecondary` (#8E8E93 - muted gray)
- Font size: `11`
- Soft, informational, not alarming

### CRUD Operations (Matches Profile List Pattern from index.tsx:1159-1260)

#### **List View: All Environment Variables (Collapsed State)**
```
┌─────────────────────────────────────────────────────────────┐
│ Environment Variables                                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ [Icon] [+] Add Variable                                     │
│  (Black button, matches profile list add button pattern)    │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ ANTHROPIC_MODEL              [Delete][Duplicate][Edit] ││
│ │ Which model Claude CLI will use                        ││
│ │                                                          ││
│ │ ✓ Value found: GLM-4.6                                  ││
│ │ Session receives: ANTHROPIC_MODEL = GLM-4.6             ││
│ └──────────────────────────────────────────────────────────┘│
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ ANTHROPIC_BASE_URL           [Delete][Duplicate][Edit] ││
│ │ API endpoint                                            ││
│ │                                                          ││
│ │ ✓ Value found: https://api.z.ai/api/anthropic          ││
│ │ Session receives: ANTHROPIC_BASE_URL = https://...     ││
│ └──────────────────────────────────────────────────────────┘│
│                                                              │
│ ... 5 more variables ...                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Styling (matches profile list at index.tsx:1163-1178, 1189-1215):**
- Container: `backgroundColor: theme.colors.input.background`, `borderRadius: 12`, `padding: 16`, `marginBottom: 12`
- Name: `fontSize: 16`, `fontWeight: '600'` (matches profileListName style)
- Description: `fontSize: 14`, `color: theme.colors.textSecondary` (matches profileListDetails)
- Status text: `fontSize: 11`, `color: theme.colors.success/warning/textDestructive`
- Action buttons (right-aligned, gap: 12):
  - Delete: `trash-outline` icon, `size: 20`, `color: #FF6B6B`
  - Duplicate: `copy-outline` icon, `size: 20`, `color: theme.colors.button.secondary.tint`
  - Edit: `create-outline` icon, `size: 20`, `color: theme.colors.button.secondary.tint`
  - All buttons have `hitSlop: { top: 10, bottom: 10, left: 10, right: 10 }`

#### **Edit Mode: Inline Expanded Card**
User clicks [Edit] button → Card expands **in place** (inline, not modal) showing full configuration UI (States 1-8 above)

**Expansion Behavior:**
- Collapsed card height: ~100px (name, description, status, buttons)
- Expanded card height: ~350px (adds checkbox, 2 input fields, warnings, preview)
- Smooth height transition (no jarring layout shifts)
- Other cards stay in place (don't jump around)
- Only one card can be expanded at a time (clicking Edit on another collapses current)

**Action Buttons in Expanded Edit Card:**
- **Header (top right):** [Delete] [Cancel] buttons
  - Delete: `trash-outline`, `size: 20`, `color: #FF6B6B` (hardcoded, matches existing pattern at index.tsx:1196)
  - Cancel: `close-outline`, `size: 20`, `color: theme.colors.button.secondary.tint`
  - gap: `12` between buttons
  - `hitSlop: { top: 10, bottom: 10, left: 10, right: 10 }`

- **Footer (bottom):** [Save] button
  - Primary button styling: `backgroundColor: theme.colors.button.primary.background`
  - Text: `fontSize: 16`, `fontWeight: '600'`, `color: theme.colors.button.primary.tint`
  - `borderRadius: 8`, `padding: 12`

**IMPORTANT - Color Variables to Use in Implementation:**
```typescript
// Status indicators
theme.colors.success           // ✓ Value found
theme.colors.warning           // ✗ Value not found (gray, same as textSecondary)
theme.colors.textSecondary     // ⚠️ Warning text (muted gray)
theme.colors.textDestructive   // Mismatch errors (red)

// Text
theme.colors.text              // Primary text (variable names, labels)
theme.colors.textSecondary     // Descriptions, secondary text

// Buttons
theme.colors.button.primary.background  // Save button background
theme.colors.button.primary.tint        // Save button text
theme.colors.button.secondary.tint      // Edit/Duplicate/Cancel icons

// Backgrounds
theme.colors.input.background  // Card backgrounds, input fields
theme.colors.surface           // Input field backgrounds (lighter)
theme.colors.surfacePressed    // Code examples

// Exception: Delete button color
#FF6B6B  // Hardcoded across codebase - matches index.tsx:1196, profiles.tsx:362
         // NOTE: Avoid using theme variable for this - use literal #FF6B6B for consistency
```

#### **Add Mode: Inline Form (Matches Existing Pattern)**
User clicks [+] Add Variable → Inline form appears (existing implementation at ProfileEditForm.tsx:1086-1170):
```
┌──────────────────────────────────────────────────────────┐
│ [Inline form with blue border]                          │
│                                                           │
│ Variable name (what session receives):                   │
│ ┌───────────────────────────────────────────────┐       │
│ │ MY_CUSTOM_VAR                                 │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ ☐ First try copying variable from remote machine:       │
│ ┌───────────────────────────────────────────────┐       │
│ │                                   [disabled]  │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ Value:                                                   │
│ ┌───────────────────────────────────────────────┐       │
│ │ my-value                                      │       │
│ └───────────────────────────────────────────────┘       │
│                                                           │
│ [Cancel]                                    [Add]        │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

**Styling (matches existing implementation):**
- Container: `backgroundColor: theme.colors.input.background`, `borderRadius: 10`, `borderWidth: 2`, `borderColor: theme.colors.button.primary.background`
- Inputs: `backgroundColor: theme.colors.surface`, `borderRadius: 10`, `fontSize: 14`
- Buttons: Cancel (secondary), Add (primary)

#### **Delete: Button in Edit Mode**
When editing a variable, [Delete] button appears in header

### State Management

```typescript
// Single unified array for all variables (built-in and custom)
const [environmentVariables, setEnvironmentVariables] = React.useState<
  Array<{
    name: string;  // e.g., "ANTHROPIC_MODEL"
    value: string; // e.g., "${Z_AI_MODEL:-GLM-4.6}" or "GLM-4.6"
  }>
>(profile.environmentVariables || []);

// Edit a variable
const handleEditVariable = (index: number, newConfig: {
  useRemoteVariable: boolean;
  remoteVariableName: string;
  defaultValue: string;
}) => {
  const updated = [...environmentVariables];
  updated[index] = {
    ...updated[index],
    value: newConfig.useRemoteVariable
      ? `\${${newConfig.remoteVariableName}:-${newConfig.defaultValue}}`
      : newConfig.defaultValue
  };
  setEnvironmentVariables(updated);
};

// Add a variable
const handleAddVariable = (name: string, value: string) => {
  setEnvironmentVariables([...environmentVariables, { name, value }]);
};

// Delete a variable
const handleDeleteVariable = (index: number) => {
  setEnvironmentVariables(environmentVariables.filter((_, i) => i !== index));
};

// Save (profile level)
const handleSave = () => {
  onSave({
    ...profile,
    environmentVariables,
    // ... other fields
  });
};
```

### Implementation Details

#### **Parsing Variable Configuration**

```typescript
// Determine if value uses remote variable with fallback
function parseVariableValue(value: string): {
  useRemoteVariable: boolean;
  remoteVariableName: string;
  defaultValue: string;
} {
  // Match: ${VARIABLE_NAME:-default_value}
  const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*):-(.*)\}$/);

  if (match) {
    return {
      useRemoteVariable: true,
      remoteVariableName: match[1],
      defaultValue: match[2]
    };
  }

  // Literal value (no template)
  return {
    useRemoteVariable: false,
    remoteVariableName: '',
    defaultValue: value
  };
}
```

#### **Querying Remote Variables**

```typescript
// Extract variable names to query from checkbox-enabled variables
const variableNamesToQuery = environmentVariables
  .map(ev => parseVariableValue(ev.value))
  .filter(parsed => parsed.useRemoteVariable)
  .map(parsed => parsed.remoteVariableName);

// Use existing hook
const { variables: remoteValues } = useEnvironmentVariables(
  machineId,
  variableNamesToQuery
);

// Display status for each variable
const getVariableStatus = (remoteVariableName: string) => {
  if (!machineId) return { type: 'no-machine' };

  const value = remoteValues[remoteVariableName];
  if (value === undefined) return { type: 'loading' };
  if (value === null) return { type: 'not-found' };
  return { type: 'found', value };
};
```

#### **Warning Logic**

```typescript
// Show "differs" warning when remote value doesn't match expected
const showRemoteDiffersWarning =
  remoteValue !== null &&
  expectedValue !== undefined &&
  remoteValue !== expectedValue;

// Show "overriding" warning when user changed default from expected
const showDefaultOverrideWarning =
  defaultValue !== expectedValue;
```

## Expected Outcomes

### User Benefits

1. **Clear Control:** Checkbox makes read-vs-write decision explicit
2. **Immediate Feedback:** See actual remote values while configuring
3. **Guided Setup:** Expected values show what to set in shell
4. **Flexibility:** Support contractor scenario (multiple accounts with different variables)
5. **Safety Warnings:** Muted gray warnings when values differ from documentation

### Technical Benefits

1. **Single Data Structure:** One array for all variables (no "built-in" vs "custom" split)
2. **Reuses Existing Hook:** `useEnvironmentVariables()` already implemented
3. **Bash Fallback Syntax:** `${VAR:-default}` handled by shell at session spawn
4. **No Schema Changes:** Uses existing `environmentVariables` array structure
5. **Backward Compatible:** Existing profiles continue to work

## Files to Modify

### 1. `sources/components/ProfileEditForm.tsx`
**Changes:**
- Refactor environment variables section to show edit UI
- Add checkbox for "First try copying variable from remote machine"
- Add variable name and default value input fields
- Show remote variable status (✓ found, ✗ not found, ⏳ loading)
- Show warnings for differs/overriding (muted gray)
- Add [Edit] button to each variable card
- Add [+] Add Variable button
- Add [Delete] button in edit mode
- Implement parseVariableValue() helper
- Query remote variables using useEnvironmentVariables()

**Lines affected:** ~300-1100 (environment variables display section)

### 2. `sources/hooks/useEnvironmentVariables.ts`
**Changes:**
- Already implemented (no changes needed)
- Currently queries variables and returns values
- Used by ProfileEditForm to check remote machine

**Status:** ✅ Complete

### 3. `sources/sync/settings.ts`
**Changes:**
- Schema already supports arbitrary environment variables
- No schema changes needed
- Bash fallback syntax `${VAR:-default}` handled by shell

**Status:** ✅ No changes needed

## Testing Strategy

### Test Cases

**TC1: Z.AI Profile - All Variables Set**
- Remote machine has all Z_AI_* variables
- All checkboxes checked
- All show ✓ Value found
- No warnings

**TC2: Z.AI Profile - Missing Variable**
- Remote machine missing Z_AI_MODEL
- Shows ✗ Value not found
- Falls back to default GLM-4.6
- Clear what to add to ~/.zshrc

**TC3: Contractor with Two Accounts**
- User has Z_AI_MODEL_ACCOUNT1 and Z_AI_MODEL_ACCOUNT2
- Creates two profiles, each pointing to different variable
- Both show ✓ Value found with different values

**TC4: User Changes Default**
- User changes default from GLM-4.6 to GLM-4.8
- Shows ⚠️ Overriding documented default (muted gray)
- Not alarming, just informational

**TC5: Remote Value Differs**
- Remote Z_AI_MODEL = GLM-4.7-Preview
- Expected = GLM-4.6
- Shows ⚠️ Differs from documented value (muted gray)

**TC6: Hardcoded Value (Checkbox Unchecked)**
- User unchecks checkbox
- Enters GLM-4.8-Experimental
- Shows ⚠️ Differs from documented value (muted gray)
- No remote query happens

**TC7: Add Custom Variable**
- User clicks [+] Add Variable
- Enters MY_CUSTOM_VAR = my-value
- Variable appears in list
- Can edit/delete after adding

**TC8: Delete Variable**
- User clicks [Edit] then [Delete]
- Variable removed from profile
- No confirmation (just remove from list)

## Success Criteria

✅ **Clarity:** Users understand read-from-remote vs hardcoded value distinction
✅ **Visibility:** Users see actual remote values while configuring
✅ **Flexibility:** Supports multiple account scenario (contractor use case)
✅ **Guidance:** Expected values help users configure their shells correctly
✅ **Safety:** Warnings (muted gray) inform without alarming
✅ **Completeness:** Full CRUD operations (create, read, update, delete)
✅ **Consistency:** Same pattern for built-in and custom variables
✅ **Performance:** Real-time validation using existing useEnvironmentVariables hook

---

**Status:** 📋 DESIGN SPECIFICATION COMPLETE - Ready for Implementation
