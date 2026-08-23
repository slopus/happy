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

export type HomeDockPickerBackAction = 'close-picker' | 'close-focus';

/**
 * Every picker is now opened straight from the control it belongs to, so there
 * is no settings root to unwind to: Back closes the picker, then the dock.
 */
export function resolveHomeDockPickerBackAction({
    hasPage,
}: {
    hasPage: boolean;
}): HomeDockPickerBackAction {
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

export type HomeDockBackdropPressAction = 'dismiss-menu' | 'close-picker' | 'close-focus';

export function resolveHomeDockBackdropPressAction({
    nativeMenuOpen,
    pickerVisible,
}: {
    nativeMenuOpen: boolean;
    pickerVisible: boolean;
}): HomeDockBackdropPressAction {
    if (nativeMenuOpen) {
        return 'dismiss-menu';
    }
    if (pickerVisible) {
        return 'close-picker';
    }
    return 'close-focus';
}
