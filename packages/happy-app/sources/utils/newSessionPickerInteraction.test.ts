import { describe, expect, it, vi } from 'vitest';

import {
    NEW_SESSION_PICKER_LAYERS,
    cancelPendingPickerOpenState,
    resolvePickerToggleAction,
} from './newSessionPickerInteraction';

describe('new-session picker interaction', () => {
    it('keeps config triggers tappable while the backdrop still guards the composer', () => {
        expect(NEW_SESSION_PICKER_LAYERS.backdrop).toBeGreaterThan(NEW_SESSION_PICKER_LAYERS.composer);
        expect(NEW_SESSION_PICKER_LAYERS.backdrop).toBeLessThan(NEW_SESSION_PICKER_LAYERS.config);
        expect(NEW_SESSION_PICKER_LAYERS.popup).toBeGreaterThan(NEW_SESSION_PICKER_LAYERS.config);
    });

    it('does not cancel an opening that is only waiting for keyboard dismissal', () => {
        expect(resolvePickerToggleAction({
            activePicker: null,
            pendingPicker: 'model',
            requestedPicker: 'model',
        })).toBe('keep-pending');
    });

    it('still closes a picker that is already visible', () => {
        expect(resolvePickerToggleAction({
            activePicker: 'model',
            pendingPicker: null,
            requestedPicker: 'model',
        })).toBe('close-active');
    });

    it('cancels the keyboard listener and fallback timer when dismissed', () => {
        vi.useFakeTimers();
        const remove = vi.fn();
        const open = vi.fn();
        const pendingPickerRef = { current: 'model' as string | null };
        const subscriptionRef = { current: { remove } as { remove: () => void } | null };
        const timerRef = {
            current: setTimeout(open, 420) as unknown as ReturnType<typeof setTimeout> | null,
        };

        cancelPendingPickerOpenState({ pendingPickerRef, subscriptionRef, timerRef });
        vi.runAllTimers();

        expect(pendingPickerRef.current).toBeNull();
        expect(subscriptionRef.current).toBeNull();
        expect(timerRef.current).toBeNull();
        expect(remove).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
