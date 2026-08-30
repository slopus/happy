export function resolveCustomProjectPathSelection(
    path: string | null | undefined,
    isMounted: boolean,
) {
    if (!isMounted) {
        return null;
    }
    const trimmedPath = path?.trim();
    return trimmedPath || null;
}

export type HomeDockPickerBackAction = 'refuse' | 'close-picker' | 'close-focus';

/**
 * Every picker is now opened straight from the control it belongs to, so there
 * is no settings root to unwind to: Back closes the picker, then the dock.
 * While a session is being created the dock is the only report of that work, so
 * Back is refused the same way a tap outside is — and refused visibly, pointing
 * at Stop, which is the way out.
 */
export function resolveHomeDockPickerBackAction({
    hasPage,
    starting = false,
}: {
    hasPage: boolean;
    starting?: boolean;
}): HomeDockPickerBackAction {
    if (starting) {
        return 'refuse';
    }
    return hasPage ? 'close-picker' : 'close-focus';
}

export function isHomeDockOptionSelectable(disabled?: boolean) {
    return disabled !== true;
}

export function shouldUseNativeHomeDockMenus(platform: string) {
    return platform !== 'android';
}

export function resolveHomeDockMachineSelection(
    selectedMachineId: string | null,
    availableMachineIds: string[],
) {
    // An empty catalog can be a transient sync state. Preserve the persisted
    // selection until the catalog arrives instead of clearing it on startup.
    if (availableMachineIds.length === 0) {
        return selectedMachineId;
    }
    if (selectedMachineId && availableMachineIds.includes(selectedMachineId)) {
        return selectedMachineId;
    }
    // HomeDock already renders the first (online-first) option as its fallback.
    // Persist that same ID so submission cannot validate a stale hidden value
    // while the UI appears to have a real machine selected.
    return availableMachineIds[0];
}

export function resolveHomeDockPromptPlaceholder(agentKey: string, agentName: string) {
    if (agentKey === 'claude') return 'Ask Claude Code';
    if (agentKey === 'codex') return 'Ask Codex';
    return `Ask ${agentName}`;
}

export type HomeDockBackdropPressAction = 'refuse' | 'dismiss-menu' | 'close-picker' | 'close-focus';

export function resolveHomeDockBackdropPressAction({
    nativeMenuOpen,
    pickerVisible,
    starting = false,
}: {
    nativeMenuOpen: boolean;
    pickerVisible: boolean;
    starting?: boolean;
}): HomeDockBackdropPressAction {
    if (nativeMenuOpen) {
        return 'dismiss-menu';
    }
    // A tap outside is the usual way out of the composer, and while a session
    // is being created it is not one — Stop is. Refusing says so; swallowing
    // the tap silently leaves the screen looking broken.
    if (starting) {
        return 'refuse';
    }
    if (pickerVisible) {
        return 'close-picker';
    }
    return 'close-focus';
}
