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
    resolveAgentIdForPermissionUi: () => 'codex',
}));

vi.mock('@/agents/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'codexDecision',
        yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
        yesForSessionKey: 'codex.permissions.yesForSession',
        stopAndExplainKey: 'codex.permissions.stopAndExplain',
    }),
}));

describe('PermissionFooter (codexDecision)', () => {
    it('shows a permission summary line', async () => {
        const { PermissionFooter } = await import('./PermissionFooter');

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'execute',
                    toolInput: { command: 'pwd' },
                    metadata: { flavor: 'codex' },
                }),
            );
        });

        const texts = tree!.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        const flattened = texts.flatMap((c: any) => Array.isArray(c) ? c : [c]).filter((c: any) => typeof c === 'string');
        expect(flattened).toContain('Run: pwd');
    });

    it('Stop denies permission and aborts the run', async () => {
        sessionDeny.mockClear();
        sessionAbort.mockClear();

        const { PermissionFooter } = await import('./PermissionFooter');

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'execute',
                    toolInput: { command: 'pwd' },
                    metadata: { flavor: 'codex' },
                }),
            );
        });

        const buttons = tree!.root.findAllByType('TouchableOpacity' as any);
        // Last button is "stop and explain"
        const stop = buttons[buttons.length - 1];

        await act(async () => {
            await stop.props.onPress();
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionAbort).toHaveBeenCalledTimes(1);
    });
});
