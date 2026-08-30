import { afterEach, describe, expect, it } from 'vitest';
import {
    loadPendingSessionPinnedState,
    recoverPendingSettingsWithPinnedState,
    savePendingSessionPinnedState,
} from './persistence';

describe('pending pinned-session persistence', () => {
    afterEach(() => savePendingSessionPinnedState(null));

    it('stores the pending value and merge base as one recoverable state', () => {
        savePendingSessionPinnedState({
            value: ['local-added', 'session-a'],
            base: ['session-a'],
            clearRaw: true,
        });

        expect(loadPendingSessionPinnedState()).toEqual({
            value: ['local-added', 'session-a'],
            base: ['session-a'],
            clearRaw: true,
        });
    });

    it('clears the complete state after acknowledgement', () => {
        savePendingSessionPinnedState({ value: [], base: ['session-a'], clearRaw: true });
        savePendingSessionPinnedState(null);

        expect(loadPendingSessionPinnedState()).toBeNull();
    });

    it('drops both mirrored pin fields when the atomic state is absent after an acknowledgement', () => {
        expect(recoverPendingSettingsWithPinnedState({
            viewInline: true,
            sessionPinnedOrder: ['stale-pin'],
            sessionPinnedOrderRaw: null,
        }, null)).toEqual({ viewInline: true });
    });

    it('recovers the pin value and raw reset together from atomic state', () => {
        expect(recoverPendingSettingsWithPinnedState({}, {
            value: ['session-a'],
            base: [],
            clearRaw: true,
        })).toEqual({
            sessionPinnedOrder: ['session-a'],
            sessionPinnedOrderRaw: null,
        });
    });
});
