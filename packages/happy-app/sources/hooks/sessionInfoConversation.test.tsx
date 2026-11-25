import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import SessionInfo from '../app/(app)/session/[id]/info';

const mocks = vi.hoisted(() => ({
    routeId: 'conversation-root', sessions: {} as Record<string, Session>, ready: true,
    back: vi.fn(), push: vi.fn(), hydrate: vi.fn(), refresh: vi.fn(), repair: vi.fn(), quickActions: vi.fn(), status: vi.fn(),
    archive: vi.fn(), delete: vi.fn(), retryDelete: vi.fn(), copy: vi.fn(), alert: vi.fn(),
}));
vi.mock('expo-router', () => ({
    Redirect: 'Redirect', useRouter: () => ({ back: mocks.back, push: mocks.push }),
    useLocalSearchParams: () => ({ id: mocks.routeId }),
}));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Animated: {
    View: 'AnimatedView', Value: class { setValue() {} },
    loop: () => ({ start: vi.fn() }), sequence: vi.fn(), timing: vi.fn(),
} }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {
    text: '#111', textSecondary: '#777', surface: '#fff', accent: '#345',
} } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/components/CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/sync/storage', () => ({
    useSession: (id: string) => mocks.sessions[id], useIsDataReady: () => mocks.ready,
    useAllSessions: () => Object.values(mocks.sessions),
}));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionHydrated: mocks.hydrate, refreshConversationSession: mocks.refresh } }));
vi.mock('@/sync/conversationSwitch', () => ({ repairCommittedConversationMembership: mocks.repair }));
vi.mock('@/sync/retiredSessions', () => ({ isHiddenRetiredSession: () => false }));
vi.mock('@/utils/sessionUtils', () => ({
    getSessionName: (source: Session) => source.metadata?.summary?.text ?? source.id,
    useSessionStatus: (source: Session) => { mocks.status(source.id); return {
        isConnected: true, statusText: `status:${source.id}`, statusDotColor: '#0f0', statusColor: '#0f0', isPulsing: false,
    }; },
    formatOSPlatform: (value: string) => value, formatPathRelativeToHome: (value: string) => value,
    getSessionAvatarId: (source: Session) => source.id, getResumeCommand: () => null,
}));
vi.mock('@/utils/versionUtils', () => ({ isVersionSupported: () => true, MINIMUM_CLI_VERSION: '0' }));
vi.mock('@/utils/copySessionMetadataToClipboard', () => ({ copySessionMetadataToClipboard: vi.fn(), copySessionMetadataAndLogsToClipboard: vi.fn() }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: mocks.quickActions }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

function fixture() {
    const root = { id: 'conversation-root', seq: 1, createdAt: 1, updatedAt: 1,
        metadata: { path: '/project', host: 'host', machineId: 'machine', flavor: 'codex',
            summary: { text: 'Shared chat title', updatedAt: 1 }, codexThreadId: 'root-native-thread',
            conversationActiveSessionId: 'active-segment' },
    } as Session;
    const active = { ...root, id: 'active-segment', thinking: true, metadata: { ...root.metadata!,
        summary: { text: 'Native segment title', updatedAt: 1 }, conversationActiveSessionId: undefined,
        conversationRootSessionId: root.id, continuationOfSessionId: root.id, codexThreadId: 'active-native-thread',
    } } as Session;
    mocks.sessions = { [root.id]: root, [active.id]: active };
    return { root, active };
}

let renderer: any;
const item = (title: string) => renderer.root.findByProps({ title });
const text = () => renderer.root.findAllByType('Text').map((node: any) => node.props.children).join(' ');
async function mount() { await act(async () => { renderer = TestRenderer.create(<SessionInfo />); }); }

describe('session info conversation identity and destructive actions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.routeId = 'conversation-root'; mocks.ready = true;
        mocks.hydrate.mockResolvedValue(false);
        mocks.refresh.mockResolvedValue(true); mocks.repair.mockResolvedValue(false);
        mocks.copy.mockResolvedValue(undefined);
        mocks.quickActions.mockReturnValue({ archiveSession: mocks.archive, deleteSession: mocks.delete,
            confirmDeleteSession: mocks.retryDelete, archivingSession: false, deletingSession: false });
        vi.stubGlobal('__DEV__', false);
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        fixture();
    });
    afterEach(() => { act(() => renderer?.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('shows the root title and current native identity, status and activity', async () => {
        const { root, active } = fixture();
        await mount();
        expect(text()).toContain('Shared chat title');
        expect(text()).not.toContain('Native segment title');
        expect(text()).toContain(`status:${active.id}`);
        expect(item('sessionInfo.codexThreadId').props.subtitle).toBe('active-n...e-thread');
        expect(item('sessionInfo.thinking').props.detail).toBe('common.yes');
        expect(mocks.quickActions).toHaveBeenCalledWith(active, expect.any(Object));
        await act(async () => item('sessionInfo.happySessionId').props.onPress());
        expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(root.id);
    });

    it('resolves stripped membership across the complete chain from a child details URL', async () => {
        const { root, active } = fixture();
        const middle = { ...active, id: 'middle-segment', metadata: { ...active.metadata!,
            conversationRootSessionId: undefined, continuationOfSessionId: root.id } };
        mocks.sessions[middle.id] = middle;
        mocks.sessions[active.id] = { ...active, metadata: { ...active.metadata!,
            conversationRootSessionId: undefined, continuationOfSessionId: middle.id } };
        mocks.routeId = middle.id;
        await mount();
        expect(text()).toContain('Shared chat title');
        expect(mocks.quickActions).toHaveBeenCalledWith(mocks.sessions[active.id], expect.any(Object));
        await act(async () => item('sessionInfo.happySessionId').props.onPress());
        expect(mocks.copy).toHaveBeenCalledWith(root.id);
    });

    it('refreshes loaded invalid authority on explicit retry', async () => {
        const { root, active } = fixture();
        mocks.sessions[active.id] = { ...active, metadata: { ...active.metadata!, conversationRootSessionId: 'another-root' } };
        await mount();
        await act(async () => item('common.retry').props.onPress());
        expect(mocks.refresh).toHaveBeenCalledWith(root.id);
        expect(mocks.refresh).toHaveBeenCalledWith(active.id);
        expect(mocks.quickActions).not.toHaveBeenCalled();
    });

    it('delegates archive to the shared action and navigates only after its success callback', async () => {
        await mount();
        act(() => item('sessionInfo.archiveSession').props.onPress());
        expect(mocks.archive).toHaveBeenCalledOnce();
        expect(mocks.back).not.toHaveBeenCalled();
        act(() => mocks.quickActions.mock.calls.at(-1)![1].onAfterArchive());
        expect(mocks.back).toHaveBeenCalledTimes(2);
    });

    it('delegates delete to the shared confirmation without optimistic navigation', async () => {
        await mount();
        act(() => item('sessionInfo.deleteSession').props.onPress());
        expect(mocks.delete).toHaveBeenCalledOnce();
        expect(mocks.back).not.toHaveBeenCalled();
        act(() => mocks.quickActions.mock.calls.at(-1)![1].onAfterDelete());
        expect(mocks.back).toHaveBeenCalledTimes(2);
    });

    it('keeps ordinary standalone session details and actions on that same identity', async () => {
        const standalone = { ...mocks.sessions['conversation-root'], metadata: {
            ...mocks.sessions['conversation-root'].metadata!, conversationActiveSessionId: undefined,
        } };
        mocks.sessions = { [standalone.id]: standalone };
        await mount();
        expect(mocks.status).toHaveBeenCalledWith(standalone.id);
        expect(mocks.quickActions).toHaveBeenCalledWith(standalone, expect.any(Object));
        expect(item('sessionInfo.codexThreadId').props.subtitle).toBe('root-nat...e-thread');
    });

    it('loads a missing current segment once and refuses to display the previous worker as current', async () => {
        delete mocks.sessions['active-segment'];
        await mount();
        expect(mocks.hydrate).toHaveBeenCalledExactlyOnceWith('active-segment');
        expect(renderer.root.findByProps({ testID: 'session-info-unavailable' })).toBeTruthy();
        expect(mocks.status).not.toHaveBeenCalled();
        expect(mocks.quickActions).not.toHaveBeenCalled();
        expect(renderer.root.findAllByProps({ title: 'sessionInfo.codexThreadId' })).toHaveLength(0);
    });

    it('exposes safe deletion recovery when a saved plan outlives the active segment', async () => {
        const { root, active } = fixture();
        mocks.sessions[root.id] = { ...root, metadata: { ...root.metadata!, conversationDeletePlan: {
            sessionIds: [active.id, root.id], completedSessionIds: [], activeSessionId: active.id,
        } } };
        delete mocks.sessions[active.id];
        await mount();
        expect(renderer.root.findByProps({ testID: 'session-info-delete-recovery' })).toBeTruthy();
        expect(mocks.status).not.toHaveBeenCalled();
        expect(mocks.hydrate).not.toHaveBeenCalled();
        act(() => renderer.root.findByProps({ testID: 'session-info-delete-retry' }).props.onPress());
        expect(mocks.retryDelete).toHaveBeenCalledOnce();
        expect(mocks.back).not.toHaveBeenCalled();
    });

    it('finds a saved deletion plan from a stripped historical child details URL', async () => {
        const { root, active } = fixture();
        const historical = { ...active, id: 'historical-segment', metadata: { ...active.metadata!,
            conversationRootSessionId: undefined, continuationOfSessionId: root.id } };
        mocks.sessions[root.id] = { ...root, metadata: { ...root.metadata!, conversationDeletePlan: {
            sessionIds: [historical.id, active.id, root.id], completedSessionIds: [active.id], activeSessionId: active.id,
        } } };
        mocks.sessions[historical.id] = historical;
        delete mocks.sessions[active.id];
        mocks.routeId = historical.id;
        await mount();
        expect(renderer.root.findByProps({ testID: 'session-info-delete-recovery' })).toBeTruthy();
        expect(mocks.quickActions).toHaveBeenCalledWith(mocks.sessions[root.id], expect.any(Object));
        expect(mocks.status).not.toHaveBeenCalled();
    });

    it('rejects a current segment that belongs to another conversation', async () => {
        mocks.sessions['active-segment'] = { ...mocks.sessions['active-segment'], metadata: {
            ...mocks.sessions['active-segment'].metadata!, conversationRootSessionId: 'another-root',
        } };
        await mount();
        expect(renderer.root.findByProps({ testID: 'session-info-unavailable' })).toBeTruthy();
        expect(mocks.quickActions).not.toHaveBeenCalled();
    });
});
