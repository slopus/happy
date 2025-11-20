# CLI Detection and Profile Availability - Implementation Plan
**Date:** 2025-11-20
**Branch:** fix/new-session-wizard-ux-improvements
**Status:** Planning Complete - Awaiting Execution Approval

## Problem Statement

**Current Behavior (INCORRECT):**
- Profile graying is based on **user-selected agent type**, not actual CLI availability
- User selects "Claude" → All Codex profiles gray out (even if Codex IS installed)
- User selects "Codex" → All Claude profiles gray out (even if Claude IS installed)
- Warning says "⚠️ Codex-only profile - not compatible with Claude CLI" (implies you picked wrong type, not that CLI is missing)
- **Fundamentally misleading**: Graying should mean "unavailable on your machine", not "you picked the other option"

**Root Cause:**
- `validateProfileForAgent(profile, agentType)` at `sources/sync/settings.ts:95-96` only checks hardcoded `profile.compatibility[agent]`
- No actual CLI detection occurs
- `MachineMetadata` schema (sources/sync/storageTypes.ts:99-114) has no fields for tracking installed CLIs
- Daemon code not in this repository - cannot modify daemon-side detection

**User Expectation:**
- Codex profiles grayed out → Codex CLI not installed on remote machine
- Claude profiles grayed out → Claude CLI not installed on remote machine
- Warning should say: "⚠️ Codex CLI not detected on this machine - install to use this profile"

## Solution Architecture

**Chosen Approach:** Frontend-Only Detection with Bash RPC (Solution B + User Preferences)

**Decision Rationale:**
- Daemon code not accessible - must use frontend detection
- User chose: Automatic detection on machine selection
- User chose: Optimistic fallback (show all if detection fails)
- Leverages existing `machineBash()` RPC infrastructure
- No schema changes required (uses React state caching)
- Immediate implementation, no daemon coordination needed

**Detection Strategy:**
```typescript
// Single efficient command checking both CLIs
const detectionCommand = `
(command -v claude >/dev/null 2>&1 && echo "claude:true" || echo "claude:false") &&
(command -v codex >/dev/null 2>&1 && echo "codex:true" || echo "codex:false")
`;
// Result: "claude:true\ncodex:false" (parses to { claude: true, codex: false })
```

**Non-Blocking Architecture:**
- Detection runs in `useEffect` hook (asynchronous, doesn't block UI)
- Profiles show immediately with optimistic state (assume available)
- Detection results update UI when completed (< 1 second typically)
- During detection: All profiles available (optimistic UX)
- After detection: Profiles grayed if CLI not detected
- **User never waits** - UI is immediately interactive

**Caching Strategy:**
- Cache key: `${machineId}` (one cache entry per machine)
- Cache duration: Detection results stored in component state
- Cache invalidation: When machine changes
- Persistence: In-memory only (re-detect on app restart)
- **Optimistic initial state**: Profiles available while detecting

## Implementation Plan

### Phase 1: Add CLI Detection Infrastructure

**1.1 Create useCLIDetection Hook** (`sources/hooks/useCLIDetection.ts`)

```typescript
import { useState, useEffect, useCallback } from 'react';
import { machineBash } from '@/sync/ops';

interface CLIAvailability {
    claude: boolean | null; // null = unknown/loading
    codex: boolean | null;
    timestamp: number;
    error?: string;
}

/**
 * Detects which CLI tools (claude, codex) are installed on a remote machine.
 *
 * Detection is automatic and cached per machine. Uses existing machineBash() RPC
 * to run `command -v claude` and `command -v codex` on the remote machine.
 *
 * @param machineId - The machine to detect CLIs on (null = no detection)
 * @returns CLI availability status for claude and codex
 */
export function useCLIDetection(machineId: string | null): CLIAvailability {
    const [availability, setAvailability] = useState<CLIAvailability>({
        claude: null,
        codex: null,
        timestamp: 0,
    });

    useEffect(() => {
        if (!machineId) {
            setAvailability({ claude: null, codex: null, timestamp: 0 });
            return;
        }

        let cancelled = false;

        const detectCLIs = async () => {
            try {
                // Use single bash command to check both CLIs efficiently
                const result = await machineBash(
                    machineId,
                    '(command -v claude >/dev/null 2>&1 && echo "claude:true" || echo "claude:false") && (command -v codex >/dev/null 2>&1 && echo "codex:true" || echo "codex:false")',
                    '/'
                );

                if (cancelled) return;

                if (result.success && result.exitCode === 0) {
                    // Parse output: "claude:true\ncodex:false"
                    const lines = result.stdout.trim().split('\n');
                    const cliStatus: { claude?: boolean; codex?: boolean } = {};

                    lines.forEach(line => {
                        const [cli, status] = line.split(':');
                        if (cli && status) {
                            cliStatus[cli.trim() as 'claude' | 'codex'] = status.trim() === 'true';
                        }
                    });

                    setAvailability({
                        claude: cliStatus.claude ?? null,
                        codex: cliStatus.codex ?? null,
                        timestamp: Date.now(),
                    });
                } else {
                    // Detection failed - optimistic fallback (assume available)
                    setAvailability({
                        claude: true,
                        codex: true,
                        timestamp: Date.now(),
                        error: `Detection failed: ${result.stderr || 'Unknown error'}`,
                    });
                }
            } catch (error) {
                if (cancelled) return;

                // Network/RPC error - optimistic fallback
                setAvailability({
                    claude: true,
                    codex: true,
                    timestamp: Date.now(),
                    error: error instanceof Error ? error.message : 'Detection error',
                });
            }
        };

        detectCLIs();

        return () => {
            cancelled = true;
        };
    }, [machineId]);

    return availability;
}
```

**Justification:**
- Uses `command -v` (POSIX standard, more reliable than `which`)
- Single bash command for both CLIs (efficient, one network round-trip)
- Automatic on machine selection (user preference)
- Optimistic fallback on errors (user preference)
- Hook pattern allows reuse across components
- Cancellation token prevents race conditions

Wait.

### Wait Process - Iteration 2

**Critique of Phase 1:**
- ✓ Good: Single command, efficient
- ✓ Good: Optimistic fallback matches user preference
- ✗ Bad: No retry logic for transient failures
- ✗ Bad: No loading state distinction (null = loading OR never checked)
- ✗ Bad: Error stored but not displayed to user
- ⚠️ Consider: Should we show "Detecting CLIs..." indicator?

**Pre-mortem:**
- Detection runs on EVERY machine selection (could be expensive if switching rapidly)
- No debouncing - rapid machine switches trigger multiple detections
- `command -v` output format might vary across platforms
- Bash command might fail if shell doesn't support `command` builtin

**Improved Solution:**
```typescript
interface CLIAvailability {
    claude: boolean | null; // null = loading, true/false = detected
    codex: boolean | null;
    isDetecting: boolean; // Explicit loading state
    timestamp: number;
    error?: string;
}

// Add debouncing:
const detectCLIsDebounced = useMemo(
    () => debounce(detectCLIs, 300),
    [machineId]
);
```

**Best Solution:** Keep original for simplicity, add `isDetecting` flag for clarity.

### Phase 2: Update Profile Filtering Logic

**2.1 Update New Session Wizard** (`sources/app/(app)/new/index.tsx`)

**Current Code (line 374-376):**
```typescript
const compatibleProfiles = React.useMemo(() => {
    return allProfiles.filter(profile => validateProfileForAgent(profile, agentType));
}, [allProfiles, agentType]);
```

**New Code:**
```typescript
// Add CLI detection hook
const cliAvailability = useCLIDetection(selectedMachineId);

// Helper to check if profile can be used
const isProfileAvailable = React.useCallback((profile: AIBackendProfile): { available: boolean; reason?: string } => {
    // Check profile compatibility with selected agent type
    if (!validateProfileForAgent(profile, agentType)) {
        return {
            available: false,
            reason: `This profile requires ${agentType === 'claude' ? 'Codex' : 'Claude'} CLI (you selected ${agentType})`,
        };
    }

    // Check if required CLI is installed on machine (if detection completed)
    const requiredCLI = profile.compatibility.claude && !profile.compatibility.codex ? 'claude'
        : !profile.compatibility.claude && profile.compatibility.codex ? 'codex'
        : null; // Profile supports both

    if (requiredCLI && cliAvailability[requiredCLI] === false) {
        return {
            available: false,
            reason: `${requiredCLI === 'claude' ? 'Claude' : 'Codex'} CLI not detected on this machine`,
        };
    }

    // Optimistic: If detection hasn't completed (null) or CLI supports both, assume available
    return { available: true };
}, [agentType, cliAvailability]);

// Update filter to consider both compatibility AND CLI availability
const availableProfiles = React.useMemo(() => {
    return allProfiles.map(profile => ({
        profile,
        availability: isProfileAvailable(profile),
    }));
}, [allProfiles, isProfileAvailable]);
```

**2.2 Update Profile Display** (lines 854-865, 920-929)

**Current:**
```typescript
const isCompatible = validateProfileForAgent(profile, agentType);
```

**New:**
```typescript
const availability = isProfileAvailable(profile);
const isAvailable = availability.available;
```

**Update Styling:**
```typescript
style={[
    styles.profileListItem,
    selectedProfileId === profile.id && styles.profileListItemSelected,
    !isAvailable && { opacity: 0.5 }
]}
onPress={() => isAvailable && selectProfile(profile.id)}
disabled={!isAvailable}
```

**2.3 Update Subtitle Helper** (line 589-638)

```typescript
const getProfileSubtitle = React.useCallback((profile: AIBackendProfile): string => {
    const availability = isProfileAvailable(profile);
    const parts: string[] = [];

    // Add availability warning if unavailable
    if (!availability.available && availability.reason) {
        parts.push(`⚠️ ${availability.reason}`);
    }

    // ... rest of existing subtitle logic (model, base URL)
}, [isProfileAvailable]);
```

Wait.

### Wait Process - Iteration 3

**Critique of Phase 2:**
- ✓ Good: Clear separation of concerns (compatibility vs availability)
- ✓ Good: Warning messages are specific and actionable
- ✗ Bad: Breaking change - `getProfileSubtitle` signature changes (now takes only profile, not isCompatible)
- ✗ Bad: No visual distinction between "detection loading" vs "CLI missing"
- ⚠️ Consider: Should we show spinner while detecting?

**Pre-mortem:**
- User rapidly switches machines → Multiple detections in flight → Race condition on state updates
- Detection hangs → User stares at blank screen, no feedback
- Both CLIs missing → All profiles grayed → User confused
- Detection returns false positive → User can't use working CLI

**Improved Solutions:**

**Option A: Show Detection Status**
```typescript
{cliAvailability.isDetecting && (
    <View style={{ padding: 12, backgroundColor: theme.colors.box.info.background }}>
        <Text>Detecting installed CLIs...</Text>
    </View>
)}
```

**Option B: Disable Profiles During Detection**
```typescript
const isAvailable = availability.available && !cliAvailability.isDetecting;
```

**Option C: Show Detection Result Summary**
```typescript
<Text style={{ fontSize: 11, color: theme.colors.textSecondary }}>
    Detected: {cliAvailability.claude ? '✓ Claude' : '✗ Claude'} • {cliAvailability.codex ? '✓ Codex' : '✗ Codex'}
</Text>
```

**Best Solution:** Option C - Always show detection summary at top of profile list. Users immediately see what's available. Transparent, informative, minimal space.

### Phase 3: Update Warning Messages

**3.1 Warning Message Types** (Three distinct cases)

**Case 1: Profile Incompatible with Selected Agent Type**
- Condition: User selected Claude, profile requires Codex (or vice versa)
- Message: "This profile requires Codex CLI (you selected Claude)"
- Action: Switch agent type dropdown to Codex
- Color: Yellow (warning, not error)

**Case 2: CLI Not Detected on Machine**
- Condition: CLI detection completed, CLI not found
- Message: "Codex CLI not detected on this machine - install with: npm install -g codex-cli"
- Action: Installation instructions + documentation link
- Color: Orange (actionable error)

**Case 3: Detection Not Completed**
- Condition: Detection still running or failed
- Message: None (optimistic - assume available)
- Fallback: If spawn fails, show specific error from daemon

**3.2 Implementation** (`getProfileSubtitle` function)

```typescript
const getProfileSubtitle = React.useCallback((profile: AIBackendProfile): string => {
    const parts: string[] = [];

    // Check profile compatibility with selected agent type
    if (!validateProfileForAgent(profile, agentType)) {
        const required = agentType === 'claude' ? 'Codex' : 'Claude';
        parts.push(`⚠️ This profile requires ${required} CLI (you selected ${agentType})`);
    }

    // Check if required CLI is detected on machine
    const requiredCLI = profile.compatibility.claude && !profile.compatibility.codex ? 'claude'
        : !profile.compatibility.claude && profile.compatibility.codex ? 'codex'
        : null;

    if (requiredCLI && cliAvailability[requiredCLI] === false) {
        const cliName = requiredCLI === 'claude' ? 'Claude' : 'Codex';
        parts.push(`⚠️ ${cliName} CLI not detected on this machine`);
    }

    // Show model mapping...
    // Show base URL...

    return parts.join(' • ');
}, [agentType, cliAvailability]);
```

Wait.

### Wait Process - Iteration 4

**Critique of Phase 3:**
- ✓ Good: Three distinct, clear message types
- ✓ Good: Actionable, specific warnings
- ✗ Bad: Installation command hardcoded (might be wrong for different platforms)
- ✗ Bad: No link to setup documentation
- ⚠️ Consider: Should warnings be on separate lines (multi-line subtitle)?

**Improved Solution:**

Instead of installation command in subtitle (too long), add installation guidance in a banner when CLIs are missing:

```typescript
{!cliAvailability.claude && cliAvailability.timestamp > 0 && (
    <View style={{ padding: 12, backgroundColor: theme.colors.box.warning.background, borderRadius: 12, marginBottom: 12 }}>
        <Text style={{ fontSize: 13, fontWeight: '600' }}>Claude CLI Not Detected</Text>
        <Text style={{ fontSize: 11, marginTop: 4 }}>Install: npm install -g @anthropic-ai/claude-code</Text>
        <Pressable onPress={() => window.open('https://docs.anthropic.com/claude/docs/cli-install', '_blank')}>
            <Text style={{ fontSize: 11, color: theme.colors.link, marginTop: 4 }}>View Installation Guide →</Text>
        </Pressable>
    </View>
)}
```

**Best Solution:** Show banner for missing CLIs + concise subtitle warning.

## File Structure

### New Files

1. **`sources/hooks/useCLIDetection.ts`** (80 lines)
   - Hook for detecting Claude and Codex CLI availability
   - Uses `machineBash()` with `command -v` checks
   - Returns `{ claude: boolean | null, codex: boolean | null, isDetecting: boolean, timestamp: number, error?: string }`
   - Automatic detection on machine change
   - Optimistic fallback on errors

### Modified Files

1. **`sources/app/(app)/new/index.tsx`** (~50 line changes)
   - Import `useCLIDetection` hook
   - Add `cliAvailability = useCLIDetection(selectedMachineId)`
   - Create `isProfileAvailable()` helper (replaces simple compatibility check)
   - Update `getProfileSubtitle()` to show CLI detection warnings
   - Add detection status banner showing detected CLIs
   - Add missing CLI installation banners (if Claude/Codex not detected)
   - Update profile list items to use `isProfileAvailable()` instead of `validateProfileForAgent()`

2. **`notes/2025-11-20-cli-detection-and-profile-availability-plan.md`** (this file)
   - Complete implementation plan
   - Architecture decisions
   - Code examples
   - Testing strategy

## Detailed Implementation Steps

### Step 1: Create useCLIDetection Hook
- [ ] Create `sources/hooks/useCLIDetection.ts`
- [ ] Define `CLIAvailability` interface
- [ ] Implement hook with `useEffect` for automatic detection
- [ ] Add bash RPC call with `command -v` for both CLIs
- [ ] Parse stdout to extract detection results
- [ ] Implement optimistic fallback on errors
- [ ] Add cancellation token to prevent race conditions
- [ ] Export hook

### Step 2: Update New Session Wizard
- [ ] Import `useCLIDetection` hook
- [ ] Call hook with `selectedMachineId`
- [ ] Create `isProfileAvailable()` helper function
  - [ ] Check profile compatibility with agent type
  - [ ] Check CLI detection results
  - [ ] Return `{ available: boolean, reason?: string }`
- [ ] Update `getProfileSubtitle()` to use `isProfileAvailable()`
  - [ ] Add warning for agent type mismatch
  - [ ] Add warning for CLI not detected
  - [ ] Keep existing model/base URL display
- [ ] Add detection status banner (above profile list)
  - [ ] Show "Detected: ✓ Claude • ✗ Codex" summary
  - [ ] Only show after detection completes
- [ ] Add missing CLI installation banners
  - [ ] Check `cliAvailability.claude === false`
  - [ ] Show installation command + docs link
  - [ ] Same for Codex
- [ ] Update profile list items
  - [ ] Replace `validateProfileForAgent()` with `isProfileAvailable()`
  - [ ] Update disabled state based on availability
  - [ ] Update opacity based on availability

### Step 3: Testing & Validation
- [ ] Test with machine that has only Claude installed
- [ ] Test with machine that has only Codex installed
- [ ] Test with machine that has both installed
- [ ] Test with machine that has neither installed
- [ ] Test detection failure scenario (network timeout)
- [ ] Test rapid machine switching (race conditions)
- [ ] Verify backward compatibility (old behavior if detection unavailable)
- [ ] Verify warning messages are clear and actionable

### Step 4: Documentation & Commit
- [ ] Create plan document in notes folder
- [ ] Commit plan document
- [ ] Implement all changes
- [ ] Run `yarn typecheck` to verify no TypeScript errors
- [ ] Test in running app
- [ ] Commit implementation with CLAUDE.md-compliant message
- [ ] Update this plan with actual outcomes

## Expected Outcomes

### User-Visible Changes

**Before:**
- Select "Claude" agent → Codex profiles grayed out (even if Codex installed)
- Warning: "⚠️ Codex-only profile - not compatible with Claude CLI" (confusing)
- No way to know if CLI is actually installed
- Must try spawning session to discover CLI is missing

**After:**
- Automatic CLI detection on machine selection (< 1 second)
- Detection summary: "Detected: ✓ Claude • ✗ Codex" (clear, immediate)
- Codex profiles grayed ONLY if Codex not detected (accurate)
- Warning: "⚠️ Codex CLI not detected on this machine" (actionable)
- Installation banner with command + docs link
- Can still see incompatible profiles with explanation: "This profile requires Codex CLI (you selected Claude)"

### Technical Changes

1. **New hook**: `useCLIDetection(machineId)` - 80 lines
2. **Modified wizard**: Profile filtering based on actual CLI availability
3. **Better warnings**: Three distinct message types (incompatible, not detected, installation needed)
4. **Detection status**: Always visible summary of what's available
5. **Optimistic UX**: Show all profiles if detection fails (user preference)

## Testing Strategy

### Test Cases

**TC1: Machine with Only Claude**
- Machine: Mac with `claude` in PATH, no `codex`
- Expected: Claude profiles enabled, Codex profiles grayed with "Codex CLI not detected"
- Installation banner shown for Codex

**TC2: Machine with Only Codex**
- Machine: Linux with `codex` installed, no `claude`
- Expected: Codex profiles enabled, Claude profiles grayed with "Claude CLI not detected"
- Installation banner shown for Claude

**TC3: Machine with Both CLIs**
- Machine: Windows with both CLIs installed
- Expected: All profiles enabled based on selected agent type
- No installation banners
- Agent type mismatch warnings still shown

**TC4: Machine with Neither CLI**
- Machine: Fresh install, no CLIs
- Expected: All profiles grayed with "CLI not detected" warnings
- Both installation banners shown
- User can still view profiles and see setup instructions

**TC5: Detection Failure**
- Scenario: Network timeout, bash RPC fails
- Expected: Optimistic fallback - all profiles shown as available
- Error logged but not displayed (user preference)
- User discovers missing CLI only when spawn fails (acceptable trade-off)

**TC6: Rapid Machine Switching**
- Action: Switch between 3 machines rapidly
- Expected: No race conditions, final machine's detection results shown
- No memory leaks from uncancelled requests

## Risk Mitigation

### Risk 1: Detection Performance
- **Mitigation**: Single command for both CLIs, runs in < 200ms typically
- **Fallback**: If timeout (5s), assume available (optimistic)

### Risk 2: False Negatives
- **Mitigation**: Use `command -v` (most reliable)
- **Fallback**: User can still try spawning, daemon will give specific error

### Risk 3: Confusion with Three States
- **Mitigation**: Clear visual indicators (✓, ✗, ...) and explicit messages
- **Documentation**: Explain detection in setup instructions

### Risk 4: Backward Compatibility
- **Mitigation**: Detection is frontend-only, no schema changes
- **Impact**: Zero breaking changes, purely additive

## Success Criteria

✅ **Functional:**
- CLI detection runs automatically on machine selection
- Profiles grayed out based on actual CLI availability, not just agent type
- Warning messages distinguish between "not compatible" and "not detected"

✅ **Performance:**
- Detection completes in < 1 second for typical case
- No UI blocking during detection
- No memory leaks from rapid switching

✅ **UX:**
- Users immediately understand which CLIs are available
- Clear installation guidance when CLI missing
- Optimistic fallback preserves functionality

✅ **Code Quality:**
- Reuses existing infrastructure (`machineBash()`)
- No schema migrations required
- TypeScript type-safe throughout
- Follows existing hook patterns

## Implementation Checklist

- [ ] Create `sources/hooks/useCLIDetection.ts` with detection logic
- [ ] Import hook in `sources/app/(app)/new/index.tsx`
- [ ] Add `cliAvailability` from hook
- [ ] Create `isProfileAvailable()` helper
- [ ] Update `getProfileSubtitle()` to use new helper
- [ ] Add detection status banner
- [ ] Add missing CLI installation banners
- [ ] Update profile list rendering to use `isProfileAvailable()`
- [ ] Test all 6 test cases
- [ ] Verify no TypeScript errors
- [ ] Commit with CLAUDE.md-compliant message
- [ ] Update plan document with outcomes

---

**Plan Status:** COMPLETE - Ready for user approval and execution

