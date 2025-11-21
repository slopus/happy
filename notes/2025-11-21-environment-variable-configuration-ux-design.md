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

### CRUD Operations

**DESIGN DECISION: All Variables Editable By Default (No Collapse/Expand)**

User is already in "Edit Profile" mode - adding another layer of "view → edit" is redundant and violates "Easy to Use Correctly" principle. All environment variables shown in fully editable state by default.

#### **Variable Card (All Editable By Default)**

Matches profile list pattern (index.tsx:1163-1217) but all fields editable since user is already in Edit Profile mode:

```
┌──────────────────────────────────────────────────────────┐
│ ANTHROPIC_MODEL                    [Delete] [Duplicate]  │
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
└──────────────────────────────────────────────────────────┘
```

**Card Styling (matches profile list at index.tsx:1163-1178):**
```typescript
backgroundColor: theme.colors.input.background  // #F5F5F5
borderRadius: 12
padding: 16
marginBottom: 12
flexDirection: 'column'  // Vertical layout for form fields
```

**Action Buttons (top right corner, matches index.tsx:1185-1216):**
```typescript
// Container for buttons
flexDirection: 'row'
alignItems: 'center'
gap: 12
// Position at top right of card

// Delete button
<Ionicons name="trash-outline" size={20} color={theme.colors.deleteAction} />
hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}

// Duplicate button
<Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
```

**No [Edit] button** - everything is already editable!

**Typography:**
- Variable name (ANTHROPIC_MODEL): `fontSize: 12`, `fontWeight: '600'`, `color: theme.colors.text`
- Description: `fontSize: 11`, `color: theme.colors.textSecondary`
- Labels ("First try copying...", "Default value:"): `fontSize: 11`, `color: theme.colors.textSecondary`
- Input fields: `fontSize: 14`, `backgroundColor: theme.colors.surface`, `borderRadius: 10`
- Status text: `fontSize: 11`, `color: theme.colors.success/warning/textSecondary`

#### **[+] Add Variable Button (Top of Section)**

Matches profile list "Add Profile" button pattern (index.tsx:1269-1308):
```typescript
<Pressable style={{
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.button.primary.background,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
}}>
    <Ionicons name="add" size={16} color={theme.colors.button.primary.tint} />
    <Text style={{
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
    }}>Add Variable</Text>
</Pressable>
```

#### **Add Mode: Inline Form**
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

## Component Architecture (DRY - Matches Profile List Pattern)

### Rendering Pattern: Simple Array Map

**Matches profile list implementation** (index.tsx:1159-1219):
```typescript
environmentVariables.map((envVar, index) => (
    <EnvironmentVariableCard
        key={index}
        variable={envVar}
        machineId={machineId}
        expectedValue={getExpectedValue(envVar.name)}
        description={getDescription(envVar.name)}
        onUpdate={(newValue) => handleUpdateVariable(index, newValue)}
        onDelete={() => handleDeleteVariable(index)}
        onDuplicate={() => handleDuplicateVariable(index)}
    />
))
```

**NOT using SearchableListSelector** - Environment variables don't need search/favorites/recent sections like machines/paths do.

### New Component 1: `sources/components/EnvironmentVariablesList.tsx`

**Purpose:** Complete environment variables section with title, add button, and card list

**Props:**
```typescript
interface EnvironmentVariablesListProps {
    environmentVariables: Array<{ name: string; value: string }>;
    machineId: string | null;
    profileDocs?: ProfileDocumentation | null;  // For expected values
    onChange: (newVariables: Array<{ name: string; value: string }>) => void;
}
```

**Renders:**
- Section title
- [+] Add Variable button
- Maps over array rendering EnvironmentVariableCard for each
- Handles add/update/delete/duplicate logic internally

**Usage in ProfileEditForm:**
```tsx
<EnvironmentVariablesList
    environmentVariables={environmentVariables}
    machineId={machineId}
    profileDocs={profileDocs}
    onChange={setEnvironmentVariables}
/>
```

### New Component 2: `sources/components/EnvironmentVariableCard.tsx`

**Purpose:** Single variable card (used by EnvironmentVariablesList)

**Props:**
```typescript
interface EnvironmentVariableCardProps {
    variable: { name: string; value: string };
    machineId: string | null;
    expectedValue?: string;  // From profile documentation (e.g., "GLM-4.6")
    description?: string;    // Variable description (e.g., "Default model")
    onUpdate: (newValue: string) => void;
    onDelete: () => void;
    onDuplicate: () => void;
}
```

**Card Structure (matches profile list at index.tsx:1163-1217):**
```typescript
<View style={{
    backgroundColor: theme.colors.input.background,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12
}}>
    {/* Header row */}
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 12, fontWeight: '600' }}>{variable.name}</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
            <Pressable onPress={onDelete}>
                <Ionicons name="trash-outline" size={20} color={theme.colors.deleteAction} />
            </Pressable>
            <Pressable onPress={onDuplicate}>
                <Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
            </Pressable>
        </View>
    </View>

    {/* Description */}
    {description && <Text style={{ fontSize: 11, color: theme.colors.textSecondary }}>{description}</Text>}

    {/* Checkbox + inputs + status + warnings */}
    {/* ... (see Visual Design states above) ... */}
</View>
```

**Benefits:**
- Reusable in other contexts (session settings, daemon config)
- Self-contained logic (parsing ${VAR}, querying remote, validation)
- Single responsibility (one variable)
- Matches existing card pattern (profile list)

### Updated Component: `sources/components/ProfileEditForm.tsx`

**Changes:**
- Import EnvironmentVariablesList component
- Reorder sections: Move Setup Instructions box and Environment Variables to bottom
- Replace both "Required Environment Variables" (lines 279-422) and "Custom Environment Variables" (lines 894-1100) with single EnvironmentVariablesList component
- All variables (documented + custom) unified in one editable section

**New Section Order:**
1. Profile Name
2. Base URL (optional)
3. Model (optional)
4. Auth Token (optional)
5. Tmux Configuration (optional)
6. Startup Bash Script (optional)
7. **Setup Instructions** (for built-in profiles only - description + docs link, NO env vars)
8. **Environment Variables** (ALL variables - documented + custom, all editable)

**Section Structure:**
```tsx
{/* Environment Variables Section - Inline in ProfileEditForm */}
<View style={{ marginBottom: 16 }}>
    {/* Section header */}
    <Text style={{
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 12,
        ...Typography.default('semiBold')
    }}>
        Environment Variables
    </Text>

    {/* Add Variable Button (matches index.tsx Add Profile button) */}
    <Pressable
        style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: theme.colors.button.primary.background,
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 6,
            gap: 6,
            marginBottom: 12
        }}
        onPress={handleAddVariable}
    >
        <Ionicons name="add" size={16} color={theme.colors.button.primary.tint} />
        <Text style={{
            fontSize: 13,
            fontWeight: '600',
            color: theme.colors.button.primary.tint,
            ...Typography.default('semiBold')
        }}>
            Add Variable
        </Text>
    </Pressable>

    {/* Variable Cards - Simple map (matches profile list pattern) */}
    {environmentVariables.map((envVar, index) => (
        <EnvironmentVariableCard
            key={index}
            variable={envVar}
            machineId={machineId}
            expectedValue={profileDocs?.environmentVariables.find(ev =>
                ev.name === extractVarNameFromValue(envVar.value))?.expectedValue
            }
            description={profileDocs?.environmentVariables.find(ev =>
                ev.name === extractVarNameFromValue(envVar.value))?.description
            }
            onUpdate={(newValue) => {
                const updated = [...environmentVariables];
                updated[index] = { ...envVar, value: newValue };
                setEnvironmentVariables(updated);
            }}
            onDelete={() => {
                setEnvironmentVariables(environmentVariables.filter((_, i) => i !== index));
            }}
            onDuplicate={() => {
                const duplicated = { ...envVar, name: `${envVar.name}_COPY` };
                setEnvironmentVariables([...environmentVariables, duplicated]);
            }}
        />
    ))}
</View>
```

**Lines affected:**
- New file: `sources/components/EnvironmentVariablesList.tsx` (~200 lines)
- New file: `sources/components/EnvironmentVariableCard.tsx` (~300 lines)
- Modified: `sources/components/ProfileEditForm.tsx`:
  - Lines ~209-278: Keep Setup Instructions box, remove env vars from inside it
  - Lines ~279-422: Remove "Required Environment Variables" section (replaced by EnvironmentVariablesList)
  - Lines ~894-1100: Remove "Custom Environment Variables" section (replaced by EnvironmentVariablesList)
  - Move Setup Instructions box to position 7 (above Environment Variables)
  - Add EnvironmentVariablesList at position 8 (bottom of form)
  - Net reduction: ~400 lines removed, replaced with single component call

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
