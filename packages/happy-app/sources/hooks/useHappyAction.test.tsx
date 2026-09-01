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
vi.mock('@/text', () => ({
    t: (key: string) => ({
        'common.error': '错误',
        'errors.unknownError': '发生未知错误',
    })[key] ?? key,
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

    it('shows a localized non-empty fallback when an action throws a blank HappyError', async () => {
        let runAction: (() => void) | undefined;

        function Harness() {
            const [, action] = useHappyAction(async () => {
                throw new (await import('@/utils/errors')).HappyError('   ', false);
            }, { fallbackErrorMessage: '分叉会话失败' });
            runAction = action;
            return null;
        }

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<Harness />);
        });
        await act(async () => {
            runAction?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.alert).toHaveBeenCalledWith(
            '错误',
            '分叉会话失败',
            [{ text: 'OK', style: 'cancel' }],
        );

        act(() => renderer.unmount());
    });

    it('synchronously rejects a second invocation while the first action is pending', async () => {
        const pendingAction = deferred();
        const action = vi.fn(() => pendingAction.promise);
        let runAction: (() => boolean) | undefined;

        function Harness() {
            const [, doAction] = useHappyAction(action);
            runAction = doAction;
            return null;
        }

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<Harness />);
        });

        let firstAccepted: boolean | undefined;
        let secondAccepted: boolean | undefined;
        act(() => {
            firstAccepted = runAction?.();
            secondAccepted = runAction?.();
        });

        expect(firstAccepted).toBe(true);
        expect(secondAccepted).toBe(false);
        expect(action).toHaveBeenCalledTimes(1);

        await act(async () => {
            pendingAction.resolve();
            await pendingAction.promise;
            await Promise.resolve();
        });
        act(() => renderer.unmount());
    });
});
