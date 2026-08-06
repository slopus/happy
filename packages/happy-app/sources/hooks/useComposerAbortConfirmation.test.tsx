import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this hook harness.
import TestRenderer from 'react-test-renderer';

import {
    COMPOSER_ABORT_CONFIRMATION_TIMEOUT_MS,
    useComposerAbortConfirmation,
} from './useComposerAbortConfirmation';

type HookResult = ReturnType<typeof useComposerAbortConfirmation>;

function AbortConfirmationHarness({
    enabled,
    onConfirm,
    onResult,
}: {
    enabled: boolean;
    onConfirm: () => void;
    onResult: (result: HookResult) => void;
}) {
    const result = useComposerAbortConfirmation({ enabled, onConfirm });
    onResult(result);
    return null;
}

describe('useComposerAbortConfirmation', () => {
    let renderer: any;
    let result: HookResult;
    const onConfirm = vi.fn();

    function render(enabled = true) {
        act(() => {
            renderer = TestRenderer.create(
                <AbortConfirmationHarness
                    enabled={enabled}
                    onConfirm={onConfirm}
                    onResult={(nextResult) => {
                        result = nextResult;
                    }}
                />,
            );
        });
    }

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('requires a second Escape before confirming abort', () => {
        render();

        act(() => expect(result.handleEscape()).toBe(true));
        expect(result.isArmed).toBe(true);
        expect(onConfirm).not.toHaveBeenCalled();

        act(() => expect(result.handleEscape()).toBe(true));
        expect(result.isArmed).toBe(false);
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('expires the armed state and treats the next Escape as a new first press', () => {
        render();

        act(() => {
            result.handleEscape();
            vi.advanceTimersByTime(COMPOSER_ABORT_CONFIRMATION_TIMEOUT_MS);
        });
        expect(result.isArmed).toBe(false);

        act(() => result.handleEscape());
        expect(result.isArmed).toBe(true);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('disarms when the running session can no longer be aborted', () => {
        render();
        act(() => result.handleEscape());
        expect(result.isArmed).toBe(true);

        act(() => {
            renderer.update(
                <AbortConfirmationHarness
                    enabled={false}
                    onConfirm={onConfirm}
                    onResult={(nextResult) => {
                        result = nextResult;
                    }}
                />,
            );
        });

        expect(result.isArmed).toBe(false);
        expect(result.handleEscape()).toBe(false);
        expect(onConfirm).not.toHaveBeenCalled();
    });
});
