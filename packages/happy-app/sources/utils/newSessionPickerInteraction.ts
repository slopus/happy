export const NEW_SESSION_PICKER_LAYERS = {
    composer: 10,
    backdrop: 15,
    config: 20,
    popup: 151,
} as const;

export type PickerToggleAction = 'close-active' | 'keep-pending' | 'open';

export function cancelPendingPickerOpenState<T>({
    pendingPickerRef,
    subscriptionRef,
    timerRef,
}: {
    pendingPickerRef: { current: T | null };
    subscriptionRef: { current: { remove: () => void } | null };
    timerRef: { current: ReturnType<typeof setTimeout> | null };
}) {
    pendingPickerRef.current = null;
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
    }
}

export function resolvePickerToggleAction<T extends string>({
    activePicker,
    pendingPicker,
    requestedPicker,
}: {
    activePicker: T | null;
    pendingPicker: T | null;
    requestedPicker: T;
}): PickerToggleAction {
    if (activePicker === requestedPicker) {
        return 'close-active';
    }
    if (pendingPicker === requestedPicker) {
        return 'keep-pending';
    }
    return 'open';
}
