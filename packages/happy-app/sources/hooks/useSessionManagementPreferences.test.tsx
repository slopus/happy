import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionManagementPreferences } from './useSessionManagementPreferences';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    pinnedOrder: ['pin-a', 'pin-b'] as string[],
    focusOrder: ['focus-a'] as string[],
    pinnedUpdateCalls: 0,
}));

vi.mock('@/sync/persistence', () => ({
    loadSessionManagementFocusOrder: () => mocks.focusOrder,
    saveSessionManagementFocusOrder: (focusOrder: string[]) => {
        mocks.focusOrder = focusOrder;
    },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: () => mocks.pinnedOrder,
    useSettingUpdater: () => (updater: (current: string[]) => string[]) => {
        mocks.pinnedUpdateCalls += 1;
        mocks.pinnedOrder = updater(mocks.pinnedOrder);
    },
}));

type HookResult = ReturnType<typeof useSessionManagementPreferences>;

function renderHook(
    validSessionIds = ['pin-a', 'pin-b', 'focus-a'],
    prune = false,
): { current: () => HookResult; rerender: () => void; unmount: () => void } {
    let result: HookResult | undefined;

    function HookHarness() {
        result = useSessionManagementPreferences(
            validSessionIds,
            { prune },
        );
        return null;
    }

    let renderer: { update: (element: React.ReactElement) => void; unmount: () => void } | undefined;
    const element = React.createElement(HookHarness);
    act(() => {
        renderer = TestRenderer.create(element);
    });
    return {
        current: () => {
            if (!result) throw new Error('Hook did not render');
            return result;
        },
        rerender: () => act(() => renderer?.update(React.createElement(HookHarness))),
        unmount: () => act(() => renderer?.unmount()),
    };
}

describe('useSessionManagementPreferences', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.pinnedOrder = ['pin-a', 'pin-b'];
        mocks.focusOrder = ['focus-a'];
        mocks.pinnedUpdateCalls = 0;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('writes pin membership and order through synced settings while focus stays local', () => {
        const hook = renderHook();

        expect(hook.current().preferences).toEqual({
            pinnedOrder: ['pin-a', 'pin-b'],
            focusOrder: ['focus-a'],
        });

        act(() => hook.current().moveToPinned('focus-a'));
        expect(mocks.pinnedOrder).toEqual(['focus-a', 'pin-a', 'pin-b']);
        expect(mocks.focusOrder).toEqual([]);

        act(() => hook.current().moveWithinQueueByOffset('pinned', 'pin-b', -1));
        expect(mocks.pinnedOrder).toEqual(['focus-a', 'pin-b', 'pin-a']);

        act(() => hook.current().togglePinned('focus-a'));
        expect(mocks.pinnedOrder).toEqual(['pin-b', 'pin-a']);

        act(() => hook.current().moveToFocus('pin-b'));
        expect(mocks.pinnedOrder).toEqual(['pin-a']);
        expect(mocks.focusOrder).toEqual(['pin-b']);

        mocks.pinnedOrder = ['pin-b', 'pin-a'];
        hook.rerender();
        expect(mocks.focusOrder).toEqual([]);
        hook.unmount();
    });

    it('does not persistently prune a remote pin missing from the current session snapshot', () => {
        mocks.pinnedOrder = ['remote-session'];
        const hook = renderHook([], true);

        expect(mocks.pinnedOrder).toEqual(['remote-session']);
        expect(mocks.pinnedUpdateCalls).toBe(0);
        hook.unmount();
    });
});
