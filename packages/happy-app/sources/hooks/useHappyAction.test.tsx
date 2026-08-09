import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations in this workspace.
// @ts-expect-error The test only uses create and unmount.
import TestRenderer from 'react-test-renderer';

import { useHappyAction } from './useHappyAction';

const mocks = vi.hoisted(() => ({
    alert: vi.fn(),
    stateUpdates: [] as unknown[],
}));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useState: <T,>(initialState: T | (() => T)) => {
            const [value, setValue] = actual.useState(initialState);
            const trackedSetValue: typeof setValue = (nextValue) => {
                mocks.stateUpdates.push(nextValue);
                setValue(nextValue);
            };
            return [value, trackedSetValue] as const;
        },
    };
});
vi.mock('@/modal', () => ({
    Modal: { alert: mocks.alert },
}));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

describe('useHappyAction', () => {
    beforeEach(() => {
        mocks.alert.mockReset();
        mocks.stateUpdates = [];
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('does not publish loading state after its owner unmounts', async () => {
        const pendingAction = deferred();
        let runAction: (() => void) | undefined;

        function Harness() {
            const [, action] = useHappyAction(() => pendingAction.promise);
            runAction = action;
            return null;
        }

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<Harness />);
        });
        act(() => {
            runAction?.();
        });
        expect(mocks.stateUpdates).toEqual([true]);

        act(() => renderer.unmount());
        await act(async () => {
            pendingAction.resolve();
            await pendingAction.promise;
            await Promise.resolve();
        });

        expect(mocks.stateUpdates).toEqual([true]);
        expect(mocks.alert).not.toHaveBeenCalled();
    });
});
