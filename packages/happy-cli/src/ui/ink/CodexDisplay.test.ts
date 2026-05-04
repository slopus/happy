import { describe, expect, it, vi } from 'vitest';

import { handleCodexDisplayInput } from './CodexDisplay';

describe('handleCodexDisplayInput', () => {
    it('invokes the local switch callback after double-space confirmation', async () => {
        const resetConfirmation = vi.fn();
        const setConfirmationWithTimeout = vi.fn();
        const setActionInProgress = vi.fn();
        const onSwitchToLocal = vi.fn();

        await handleCodexDisplayInput({
            input: ' ',
            key: {},
            confirmationMode: 'switch',
            actionInProgress: null,
            resetConfirmation,
            setConfirmationWithTimeout,
            setActionInProgress,
            onSwitchToLocal,
            delayMs: 0,
        });

        expect(resetConfirmation).toHaveBeenCalled();
        expect(setActionInProgress).toHaveBeenCalledWith('switching');
        expect(onSwitchToLocal).toHaveBeenCalled();
        expect(setConfirmationWithTimeout).not.toHaveBeenCalled();
    });

    it('arms switch confirmation on the first space press', async () => {
        const setConfirmationWithTimeout = vi.fn();

        await handleCodexDisplayInput({
            input: ' ',
            key: {},
            confirmationMode: null,
            actionInProgress: null,
            resetConfirmation: vi.fn(),
            setConfirmationWithTimeout,
            setActionInProgress: vi.fn(),
            delayMs: 0,
        });

        expect(setConfirmationWithTimeout).toHaveBeenCalledWith('switch');
    });
});
