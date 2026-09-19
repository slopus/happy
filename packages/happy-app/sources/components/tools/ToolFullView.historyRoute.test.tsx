import * as React from 'react';
import { act } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import MessageDetail from '@/app/(app)/session/[id]/message/[messageId]';
import { ToolFullView } from './ToolFullView';
import { TranscriptReadOnlyContext } from '../TranscriptReadOnlyContext';

const fixtures = vi.hoisted(() => ({ session: { id: 'old', metadata: { continuedBySessionId: 'new' } } as any,
    message: { id: 'message-1', kind: 'tool-call', children: [], tool: {
        name: 'Bash', state: 'running', input: { command: 'echo example' }, permission: { id: 'pending', status: 'pending' },
    } } as any,
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'old', messageId: 'message-1' }),
    useRouter: () => ({ back: vi.fn() }), Stack: { Screen: 'Screen' } }));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: 400 }), Platform: { select: () => 'monospace' } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/sync/storage', () => ({ useSession: () => fixtures.session, useMessage: () => fixtures.message,
    useSessionMessages: () => ({ isLoaded: true }), useLocalSetting: () => false }));
vi.mock('@/sync/sync', () => ({ sync: { onSessionVisible: vi.fn() } }));
vi.mock('@/components/Deferred', () => ({ Deferred: ({ children }: any) => children }));
vi.mock('./ToolHeader', () => ({ ToolHeader: 'ToolHeader' }));
vi.mock('./ToolStatusIndicator', () => ({ ToolStatusIndicator: 'ToolStatusIndicator' }));
vi.mock('./PermissionFooter', () => ({ PermissionFooter: 'PermissionFooter' }));
vi.mock('../CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('../layout', () => ({ layout: { maxWidth: 900 } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./views/_all', () => ({ getToolFullViewComponent: () => null }));
vi.mock('react-native-unistyles', () => {
    const colors: any = new Proxy({}, { get: () => colors });
    return { StyleSheet: { create: (factory: any) => factory({ colors }) }, useUnistyles: () => ({ theme: { colors } }) };
});
let renderer: any;
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    (globalThis as any).__DEV__ = false;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    fixtures.session = { id: 'old', metadata: { continuedBySessionId: 'new' } };
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); errorSpy.mockRestore(); logSpy.mockRestore(); });

it('keeps approvals disabled after navigating from old history into its real message-detail route', () => {
    act(() => { renderer = TestRenderer.create(<MessageDetail />); });
    expect(renderer.root.findByType(ToolFullView).props.sessionId).toBe('old');
    expect(renderer.root.findAllByType('PermissionFooter')).toHaveLength(0);
    expect(renderer.root.findByType('CodeView').props.code).toContain('echo example');
});

it('still allows approvals on the active session detail route', () => {
    fixtures.session = { id: 'old', metadata: {} };
    act(() => { renderer = TestRenderer.create(<MessageDetail />); });
    expect(renderer.root.findByType('PermissionFooter').props.sessionId).toBe('old');
});

it('also honors read-only context when a tool detail is embedded elsewhere', () => {
    act(() => { renderer = TestRenderer.create(<TranscriptReadOnlyContext.Provider value={true}>
        <ToolFullView tool={fixtures.message.tool} sessionId="old" />
    </TranscriptReadOnlyContext.Provider>); });
    expect(renderer.root.findAllByType('PermissionFooter')).toHaveLength(0);
});
