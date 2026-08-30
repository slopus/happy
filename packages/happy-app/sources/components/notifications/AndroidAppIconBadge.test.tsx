import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations in this workspace.
import TestRenderer from 'react-test-renderer';

type BadgeHarnessState = {
    isDataReady: boolean;
    sessions: Record<string, {
        presence?: string | number | null;
        agentState?: { requests?: Record<string, unknown> | null } | null;
    }>;
    unreadSessionIds: Set<string>;
};

const harness = vi.hoisted(() => ({
    state: {
        isDataReady: true,
        sessions: {},
        unreadSessionIds: new Set<string>(),
    } as BadgeHarnessState,
    setBadgeCountAsync: vi.fn(async () => true),
    getPresentedNotificationsAsync: vi.fn(async () => [{ request: { identifier: 'existing' } }]),
    appStateListener: null as null | ((state: string) => void),
}));

vi.mock('@/sync/storage', () => ({
    storage: (selector: (state: typeof harness.state) => unknown) => selector(harness.state),
}));

vi.mock('expo-notifications', () => ({
    setBadgeCountAsync: harness.setBadgeCountAsync,
    getPresentedNotificationsAsync: harness.getPresentedNotificationsAsync,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    AppState: {
        addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
            harness.appStateListener = listener;
            return { remove: vi.fn() };
        }),
    },
}));

import { AndroidAppIconBadge } from './AndroidAppIconBadge';

describe('AndroidAppIconBadge', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        harness.state = {
            isDataReady: true,
            sessions: {},
            unreadSessionIds: new Set<string>(),
        };
        harness.setBadgeCountAsync.mockReset().mockResolvedValue(true);
        harness.getPresentedNotificationsAsync.mockReset().mockResolvedValue([
            { request: { identifier: 'existing' } },
        ]);
        harness.appStateListener = null;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('preserves presented notifications instead of clearing them for a zero badge', async () => {
        let renderer: { unmount(): void } | undefined;
        await act(async () => {
            renderer = TestRenderer.create(<AndroidAppIconBadge />);
        });

        expect(harness.getPresentedNotificationsAsync).toHaveBeenCalledOnce();
        expect(harness.setBadgeCountAsync).not.toHaveBeenCalled();

        act(() => renderer?.unmount());
    });

    it('waits for restored session data before touching the launcher badge', async () => {
        harness.state.isDataReady = false;

        let renderer: { unmount(): void } | undefined;
        await act(async () => {
            renderer = TestRenderer.create(<AndroidAppIconBadge />);
        });

        expect(harness.getPresentedNotificationsAsync).not.toHaveBeenCalled();
        expect(harness.setBadgeCountAsync).not.toHaveBeenCalled();

        act(() => renderer?.unmount());
    });

    it('sets a positive attention count without inspecting presented notifications', async () => {
        harness.state.sessions = {
            permissionRequired: {
                presence: 'online',
                agentState: { requests: { tool: {} } },
            },
        };

        let renderer: { unmount(): void } | undefined;
        await act(async () => {
            renderer = TestRenderer.create(<AndroidAppIconBadge />);
        });

        expect(harness.getPresentedNotificationsAsync).not.toHaveBeenCalled();
        expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(1);

        act(() => renderer?.unmount());
    });

    it('clears a stale zero badge when there are no notifications to lose', async () => {
        harness.getPresentedNotificationsAsync.mockResolvedValueOnce([]);

        let renderer: { unmount(): void } | undefined;
        await act(async () => {
            renderer = TestRenderer.create(<AndroidAppIconBadge />);
        });

        expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);

        act(() => renderer?.unmount());
    });

    it('reapplies a positive count when the app returns to the foreground', async () => {
        harness.state.unreadSessionIds = new Set(['completed']);

        let renderer: { unmount(): void } | undefined;
        await act(async () => {
            renderer = TestRenderer.create(<AndroidAppIconBadge />);
        });
        await act(async () => {
            harness.appStateListener?.('active');
        });

        expect(harness.setBadgeCountAsync).toHaveBeenNthCalledWith(1, 1);
        expect(harness.setBadgeCountAsync).toHaveBeenNthCalledWith(2, 1);

        act(() => renderer?.unmount());
    });

    it('does not let a stale zero update overwrite a newer positive count', async () => {
        let resolvePresentedNotifications: ((notifications: Array<{ request: { identifier: string } }>) => void) | undefined;
        harness.getPresentedNotificationsAsync.mockReturnValueOnce(new Promise((resolve) => {
            resolvePresentedNotifications = resolve;
        }));

        let renderer: { update(node: React.ReactElement): void; unmount(): void } | undefined;
        await act(async () => {
            renderer = TestRenderer.create(<AndroidAppIconBadge key="zero" />);
        });

        harness.state.unreadSessionIds = new Set(['completed']);
        await act(async () => {
            renderer?.update(<AndroidAppIconBadge key="positive" />);
        });
        expect(harness.setBadgeCountAsync).toHaveBeenCalledTimes(1);
        expect(harness.setBadgeCountAsync).toHaveBeenLastCalledWith(1);

        await act(async () => {
            resolvePresentedNotifications?.([]);
        });
        expect(harness.setBadgeCountAsync).toHaveBeenCalledTimes(1);

        act(() => renderer?.unmount());
    });
});
