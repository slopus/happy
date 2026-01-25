import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'ios', select: (v: any) => v.ios },
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                permissionButton: {
                    allow: { background: '#0f0' },
                    deny: { background: '#f00' },
                    allowAll: { background: '#00f' },
                },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const sessionDeny = vi.fn<(...args: any[]) => Promise<void>>(async (..._args: any[]) => {});
const sessionAbort = vi.fn<(...args: any[]) => Promise<void>>(async (..._args: any[]) => {});
vi.mock('@/sync/ops', () => ({
    sessionAllow: vi.fn(async () => {}),
    sessionDeny: (...args: any[]) => sessionDeny(...args),
    sessionAbort: (...args: any[]) => sessionAbort(...args),
}));

vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/agents/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'opencode',
}));

vi.mock('@/agents/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        noTellAgentKey: 'claude.permissions.stopAndExplain',
    }),
}));

describe('PermissionFooter (non-codex)', () => {
    it('Stop denies permission (abort) and aborts the run', async () => {
        sessionDeny.mockClear();
        sessionAbort.mockClear();

        const { PermissionFooter } = await import('./PermissionFooter');

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'Read',
                    toolInput: { filepath: '/etc/hosts' },
                    metadata: { flavor: 'opencode' },
                }),
            );
        });

        const buttons = tree!.root.findAllByType('TouchableOpacity' as any);
        const stop = buttons[buttons.length - 1];

        await act(async () => {
            await stop.props.onPress();
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect((sessionDeny as any).mock.calls[0]?.[4]).toBe('abort');
        expect(sessionAbort).toHaveBeenCalledTimes(1);
    });
});
