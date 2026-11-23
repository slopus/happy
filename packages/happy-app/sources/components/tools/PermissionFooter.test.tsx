import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { PermissionFooter } from './PermissionFooter';

const mocks = vi.hoisted(() => ({
    allow: vi.fn(),
    deny: vi.fn(),
    presence: 123 as 'online' | number,
    agentState: null as any,
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web' },
    StyleSheet: { create: (styles: object) => styles },
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/sync/ops', () => ({ sessionAllow: mocks.allow, sessionDeny: mocks.deny }));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
    useSession: () => ({ presence: mocks.presence, agentState: mocks.agentState }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#ddd',
                input: { background: '#fff' },
                surfacePressed: '#eee',
                text: '#111',
                textSecondary: '#666',
            },
        },
    }),
}));

function renderCodexFooter() {
    return TestRenderer.create(
        <PermissionFooter
            metadata={{ flavor: 'codex' }}
            permission={{ id: 'permission-1', status: 'pending' }}
            sessionId="session-1"
            toolName="CodexBash"
        />,
    );
}

describe('PermissionFooter offline protection', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.presence = 123;
        mocks.agentState = null;
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('keeps the pending confirmation visible but disables every Codex response while disconnected', async () => {
        let renderer: any;
        act(() => { renderer = renderCodexFooter(); });

        expect(renderer.root.findByProps({ testID: 'permission-offline-notice' })).toBeTruthy();
        for (const testID of [
            'permission-approve-button',
            'permission-approve-session-button',
            'permission-abort-button',
        ]) {
            const button = renderer.root.findByProps({ testID });
            expect(button.props.disabled).toBe(true);
            await act(async () => { await button.props.onPress(); });
        }
        expect(mocks.allow).not.toHaveBeenCalled();
        expect(mocks.deny).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });

    it('enables responses again once the session reconnects', () => {
        mocks.presence = 'online';
        let renderer: any;
        act(() => { renderer = renderCodexFooter(); });

        expect(renderer.root.findAllByProps({ testID: 'permission-offline-notice' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'permission-approve-button' }).props.disabled).toBe(false);
        expect(renderer.root.findByProps({ testID: 'permission-approve-session-button' }).props.disabled).toBe(false);
        expect(renderer.root.findByProps({ testID: 'permission-abort-button' }).props.disabled).toBe(false);

        act(() => renderer.unmount());
    });

    it('sends the exact agy persistent option instead of Claude allowedTools or bypass modes', async () => {
        mocks.presence = 'online';
        mocks.agentState = { requests: { 'permission-1': { tool: 'execute', arguments: {}, permissionOptions: [
            { id: 'once', kind: 'allow_once', name: '允许本次' },
            { id: 'scope-two', kind: 'allow_always', name: '记住此命令' },
            { id: 'reject', kind: 'reject_once', name: '拒绝' },
        ] } } };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<PermissionFooter metadata={{ flavor: 'antigravity' }}
            permission={{ id: 'permission-1', status: 'pending' }} sessionId="session-1" toolName="execute" />); });
        const button = renderer.root.findByProps({ testID: 'permission-acp-scope-two' });
        await act(async () => { await button.props.onPress(); });
        expect(mocks.allow).toHaveBeenCalledWith('session-1', 'permission-1', undefined, undefined,
            'approved_for_session', undefined, 'scope-two');
        expect(renderer.root.findAllByProps({ testID: 'permission-bypass-button' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('offers only once/deny for old ACP workers that cannot advertise persistent scopes', () => {
        mocks.presence = 'online';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<PermissionFooter metadata={{ flavor: 'antigravity' }}
            permission={{ id: 'permission-1', status: 'pending' }} sessionId="session-1" toolName="execute" />); });
        expect(renderer.root.findAllByType('TouchableOpacity')).toHaveLength(2);
        expect(renderer.root.findAllByProps({ testID: 'permission-approve-session-button' })).toHaveLength(0);
        act(() => renderer.unmount());
    });
});
