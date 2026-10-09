import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations
import TestRenderer from 'react-test-renderer';
import { AppConversationsSidebar } from './AppConversationsSidebar';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), rows: [] as any[], token: 'owner',
    onAppStateChange: undefined as undefined | ((state: string) => void),
    request: vi.fn(async (_token: string, path: string) => path === '' ? { grants: [{ id: 'grant', appId: 'advisor', machineId: null }] } : { conversations: [{ id: 'legacy', grantId: 'grant', createdAt: 1, lastActivityAt: 1, turns: [] }], nextCursor: null }),
}));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', AppState: { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => {
    mocks.onAppStateChange = listener;
    return { remove() { mocks.onAppStateChange = undefined; } };
} }, Platform: { OS: 'web' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', useWindowDimensions: () => ({ width: 400 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (f: any) => f({ colors: {} }) }, useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: { token: mocks.token } }) }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => [], useSessionListViewData: () => mocks.rows }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://paws.test' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('expo-router', () => ({ usePathname: () => '/session/native', useRouter: () => ({ navigate: mocks.navigate }) }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('./ActiveSessionsGroupCompact', () => ({ CompactSessionRow: (props: any) => React.createElement('CompactSessionRow', props) }));

describe('application session directory', () => {
    beforeEach(() => { mocks.request.mockClear(); mocks.rows = []; });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('automatically collects completed and archived rows into expandable history, and restores continued turns', async () => {
        const application = { appId: 'advisor', bindingId: 'binding' };
        mocks.rows = [
            { type: 'active-sessions', sessions: [{ id: 'ordinary', name: 'advisor' }, { id: 'native', application, state: 'running' }, { id: 'draft', application, state: 'completed', hasDraft: true }, { id: 'permission', application, state: 'permission_required' }] },
            { type: 'session', session: { id: 'completed', application, state: 'completed', archived: true } },
            { type: 'header', title: 'Yesterday' },
            { type: 'session', session: { id: 'archived', application, archived: true } },
        ];
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<AppConversationsSidebar />); });
        const rows = renderer.root.findAllByType('CompactSessionRow');
        expect(rows.map((row: any) => row.props.session.id)).toEqual(['native', 'draft', 'permission']);
        const toggle = () => renderer.root.findAllByProps({ testID: 'app-history-toggle-advisor' }).find((node: any) => node.type === 'Pressable');
        act(() => toggle().props.onPress());
        expect(renderer.root.findAllByType('CompactSessionRow').map((row: any) => row.props.session.id)).toEqual(['native', 'draft', 'permission', 'completed', 'archived']);
        act(() => toggle().props.onPress());
        // An explicitly restored completed turn stays current, even before a followup.
        mocks.rows = [{ type: 'active-sessions', sessions: [{ id: 'completed', application, state: 'completed', archived: false }] }];
        await act(async () => { renderer.update(<AppConversationsSidebar />); });
        expect(renderer.root.findAllByType('CompactSessionRow').map((row: any) => row.props.session.id)).toEqual(['completed']);

        expect(renderer.root.findAllByProps({ testID: 'app-conversation-legacy' })).toHaveLength(0);
        act(() => renderer.unmount());
    });
});
