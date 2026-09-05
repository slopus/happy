import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DuplicateSheet } from './DuplicateSheet';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    alert: vi.fn(),
    forkAndSpawn: vi.fn(),
    listRewindPoints: vi.fn(),
    replace: vi.fn(),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    useWindowDimensions: () => ({ width: 800, height: 600 }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: () => ({}),
    },
}));
vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/modal', () => ({
    Modal: { alert: mocks.alert },
}));
vi.mock('@/text', () => ({
    t: (key: string) => `localized:${key}`,
}));
vi.mock('@/sync/storage', () => ({
    useSession: () => ({
        id: 'source-session',
        metadata: {
            flavor: 'codex',
            machineId: 'machine-1',
            path: '/repo',
            codexThreadId: 'thread-1',
        },
    }),
}));
vi.mock('@/sync/ops', () => ({
    forkAndSpawn: mocks.forkAndSpawn,
    claudeListRewindPoints: mocks.listRewindPoints,
    codexListRewindPoints: mocks.listRewindPoints,
}));
vi.mock('@/utils/sessionFork', () => ({
    getSessionForkSource: () => ({
        kind: 'codex',
        machineId: 'machine-1',
        directory: '/repo',
        codexThreadId: 'thread-1',
    }),
}));
vi.mock('@/utils/duplicateSheetLayout', () => ({
    getDuplicateSheetFrame: () => ({}),
}));
vi.mock('@/utils/messageForkPoint', () => ({
    resolveInitialForkRewindPointId: () => 'item-1',
}));
vi.mock('./haptics', () => ({ hapticsSuccess: vi.fn() }));

describe('DuplicateSheet fork errors', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listRewindPoints.mockResolvedValue({
            type: 'success',
            points: [{ itemId: 'item-1', text: 'User turn', timestamp: 1 }],
        });
        mocks.forkAndSpawn.mockResolvedValue({
            type: 'error',
            errorCode: 'session-hydration-failed',
            errorMessage: 'session-hydration-failed',
            sessionId: 'spawned-session',
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('presents hydration exhaustion with localized copy instead of the transport code', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <DuplicateSheet sessionId="source-session" initialRewindPointId="item-1" />,
            );
            await Promise.resolve();
        });

        await act(async () => {
            renderer.root.findByProps({ testID: 'duplicate-sheet-confirm' }).props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.alert).toHaveBeenCalledWith(
            'localized:common.error',
            'localized:newSession.sessionHydrationFailed',
        );
        expect(mocks.alert).not.toHaveBeenCalledWith(
            'localized:common.error',
            'session-hydration-failed',
        );
        expect(mocks.replace).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });
});
