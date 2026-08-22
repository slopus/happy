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

export type HomeDockPickerBackAction = 'show-root' | 'close-picker' | 'close-focus';

export function resolveHomeDockPickerBackAction({
    hasPage,
    rootVisible,
}: {
    hasPage: boolean;
    rootVisible: boolean;
}): HomeDockPickerBackAction {
    if (hasPage && rootVisible) {
        return 'show-root';
    }
    if (hasPage || rootVisible) {
        return 'close-picker';
    }
    return 'close-focus';
}

export function isHomeDockOptionSelectable(disabled?: boolean) {
    return disabled !== true;
}

export function shouldUseNativeHomeDockMenus(platform: string) {
    return platform !== 'android';
}

export function shouldShowHomeDockEnvironmentPicker(page: string, platform: string) {
    return platform !== 'android' || page !== 'worktree';
}
