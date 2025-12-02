# Bug Fix: Machine Selection in Web Container

## Problem Description

When using happy-web to start a new session:

1. User clicks the machine name (e.g., "nelnet2025") to change it
2. A screen appears showing the list of available machines (paul, nelnet2025)
3. User clicks a different machine (e.g., "paul")
4. The screen disappears, but the main window incorrectly shows the machine list instead of the new session form
5. When user clicks "paul" again, the new session modal reappears but still shows "nelnet2025" selected

## Root Cause

The code used a module-level callback pattern to communicate the selected machine from the picker screen back to the parent:

```typescript
// Module-level variables (problematic)
let onMachineSelected: (machineId: string) => void = () => { };

export const callbacks = {
    onMachineSelected: (machineId: string) => {
        onMachineSelected(machineId);
    }
};
```

### Why It Failed

1. **Race Condition**: When `router.back()` was called immediately after the callback, navigation could complete before the state update propagated
2. **Cleanup Timing**: The useEffect cleanup function could clear the callback before it was executed
3. **Web-Specific Issue**: This pattern works better in native React Native apps but has timing issues in web environments

## Solution

Added route params to explicitly pass the selected machine ID back:

### Changes Made

**File: `sources/app/(app)/new/index.tsx`**

1. Added `selectedMachineId` to route params:
```typescript
const { prompt, dataId, selectedMachineId: machineIdFromParams } = useLocalSearchParams<{
    prompt?: string;
    dataId?: string;
    selectedMachineId?: string;
}>();
```

2. Added useEffect to handle machine selection from route params:
```typescript
React.useEffect(() => {
    if (machineIdFromParams) {
        const machine = storage.getState().machines[machineIdFromParams];
        if (machine) {
            setSelectedMachineId(machineIdFromParams);
            const bestPath = getRecentPathForMachine(machineIdFromParams, recentMachinePaths);
            setSelectedPath(bestPath);
        }
    }
}, [machineIdFromParams, recentMachinePaths]);
```

**File: `sources/app/(app)/new/pick/machine.tsx`**

Changed navigation to include the selected machine ID as a param:
```typescript
const handleSelectMachine = (machineId: string) => {
    // Call the callback for backwards compatibility
    callbacks.onMachineSelected(machineId);
    // Navigate back with the selected machine ID as a param (fixes web bug)
    router.push({
        pathname: '/new',
        params: { selectedMachineId: machineId }
    });
};
```

## Benefits

1. **Explicit State Transfer**: Machine selection is now passed explicitly via route params
2. **No Race Conditions**: Route params are guaranteed to be available when the component mounts
3. **Backwards Compatible**: Old callback mechanism still works for native platforms
4. **Web-Safe**: Works correctly in web containers where timing issues were problematic

## Testing

Tests added in `sources/app/(app)/new/machineSelection.spec.ts`:

- Demonstrates the problematic callback pattern
- Shows race conditions with navigation
- Validates the fix using route params
- Documents expected behavior

Run tests:
```bash
npm test -- machineSelection.spec.ts
```

## Related Files

- `sources/app/(app)/new/index.tsx` - Main new session screen
- `sources/app/(app)/new/pick/machine.tsx` - Machine picker screen
- `sources/app/(app)/new/machineSelection.spec.ts` - Test suite

## Future Improvements

Consider removing the module-level callback pattern entirely and using only route params or React Context for better maintainability.
