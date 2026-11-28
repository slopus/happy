import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
const mocks = vi.hoisted(() => ({ sessions: {} as Record<string, any>, status: 'connected', platformOS: 'web', list: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Platform: { get OS() { return mocks.platformOS; } }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }), StyleSheet: { create: (fn: any) => fn({ colors: { shadow: {} } }) } }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: mocks.status }), storage: (select: any) => select({ sessions: mocks.sessions, sessionMessages: {}, machines: { 'machine-a': { active: true }, 'machine-b': { active: true } } }) }));
vi.mock('@/sync/apiDelegation', () => ({ listDelegationRoles: mocks.list }));
vi.mock('@/hooks/usePlugins', () => ({ usePlugins: () => ({ plugins: [], loading: false, status: 'ready' }) }));
vi.mock('@/hooks/useWebPopoverDismiss', () => ({ useWebPopoverDismiss: () => {} }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: (session: any) => session.metadata?.summary?.text ?? session.id }));
vi.mock('./plugins/pluginText', () => ({ resolvePluginText: () => '' }));
vi.mock('@/sync/suggestionFile', () => ({ searchFiles: async () => [] }));
vi.mock('./codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
vi.mock('@/text', () => ({ t: (key: string, args?: { id: string }) => args ? `${key}:${args.id}` : key }));
import { ComposerContextPicker } from './ComposerContextPicker';
import { clearFirstSubmissionScope, setFirstSubmissionScope } from '@/sync/firstSubmissionScope';
const role = { id: 'writer-42', name: 'Technical writer', description: 'Write documentation', agent: 'antigravity', model: 'Neon', autoDelegate: false, createdAt: 1, updatedAt: 1 };
describe('Add menu role choices', () => {
    let renderer: any;
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks();
        mocks.status = 'connected'; mocks.platformOS = 'web';
        setFirstSubmissionScope('test-account', 'https://server.test');
        mocks.sessions = { parent: { id: 'parent', metadata: { machineId: 'machine-a', capabilities: { delegation: 1 } } } };
        mocks.list.mockResolvedValue([role]);
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });
    const render = async (sessionId = 'parent', onSelect = vi.fn(), query = '') => {
        await act(async () => { const node = <ComposerContextPicker query={query} sessionId={sessionId} canManageRoles onSelect={onSelect} onClose={vi.fn()} />;
            if (renderer) renderer.update(node); else renderer = TestRenderer.create(node); });
    };
    const row = () => renderer.root.findByProps({ testID: `composer-context-item-agent-role:${role.id}` });
    it('reads once on open and inserts an exact ID without starting work', async () => {
        const onSelect = vi.fn(); await render('parent', onSelect);
        expect(mocks.list).toHaveBeenCalledExactlyOnceWith('parent');
        act(() => row().props.onPress());
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ text: `delegation.useRolePrompt:${role.id}`, provider: 'antigravity' }));
        mocks.sessions.parent = { ...mocks.sessions.parent, metadata: { ...mocks.sessions.parent.metadata, delegationRoles: [role] } };
        await render('parent', onSelect, 'writer-42');
        expect(row()).toBeTruthy();
        expect(mocks.list).toHaveBeenCalledTimes(1);
    });
    it('recommends only the two most recent Android conversations on an empty query', async () => {
        mocks.platformOS = 'android';
        for (let index = 0; index < 5; index++) {
            const id = `other-${index}`;
            mocks.sessions[id] = { id, createdAt: 1, lastMessageAt: index + 1, metadata: { summary: { text: id }, path: '/work' } };
        }
        const onSelect = vi.fn();
        await render('parent', onSelect);
        const sessionRows = renderer.root.findAllByType('Pressable').filter((node: any) => node.props.testID?.startsWith('composer-context-item-session:'));
        expect(sessionRows.map((node: any) => node.props.testID)).toEqual([
            'composer-context-item-session:other-4', 'composer-context-item-session:other-3',
        ]);
        act(() => sessionRows[1].props.onPress());
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ reference: expect.objectContaining({ id: 'other-3' }) }));
    });
    it('searches Android conversations beyond the two recommendations and keeps all matching results', async () => {
        mocks.platformOS = 'android';
        for (let index = 0; index < 45; index++) {
            const id = `other-${index}`;
            mocks.sessions[id] = { id, createdAt: 1, lastMessageAt: 50 - index, metadata: { summary: { text: id }, path: '/work' } };
        }
        await render('parent', vi.fn(), 'other-44');
        expect(renderer.root.findByProps({ testID: 'composer-context-item-session:other-44' })).toBeTruthy();
        await render('parent', vi.fn(), 'other-');
        expect(renderer.root.findAllByType('Pressable').filter((node: any) => node.props.testID?.startsWith('composer-context-item-session:'))).toHaveLength(45);
    });
    it('ignores a late reply from a previous machine/session and exposes manual retry', async () => {
        let resolveOld!: (roles: any[]) => void;
        mocks.list.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
        await render();
        mocks.sessions.other = { id: 'other', metadata: { machineId: 'machine-b', capabilities: { delegation: 1 } } };
        mocks.list.mockRejectedValueOnce(new Error('offline'));
        await render('other');
        await act(async () => resolveOld([role]));
        expect(renderer.root.findAllByProps({ testID: `composer-context-item-agent-role:${role.id}` })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'composer-roles-retry' })).toBeTruthy();
        mocks.list.mockResolvedValueOnce([role]);
        await act(async () => renderer.root.findByProps({ testID: 'composer-roles-retry' }).props.onPress());
        expect(row()).toBeTruthy();
        expect(mocks.list).toHaveBeenCalledTimes(3);
    });
    it('fences cached role choices and late replies across same-ID account generations', async () => {
        setFirstSubmissionScope('account-a', 'https://server.test');
        const onSelect = vi.fn(); await render('parent', onSelect);
        const stalePress = row().props.onPress;
        let resolveNew!: (roles: any[]) => void;
        mocks.list.mockReturnValueOnce(new Promise(resolve => { resolveNew = resolve; }));
        await act(async () => { setFirstSubmissionScope('account-a', 'https://server.test'); });
        act(() => stalePress());
        expect(onSelect).not.toHaveBeenCalled();
        expect(renderer.root.findAllByProps({ testID: `composer-context-item-agent-role:${role.id}` })).toHaveLength(0);
        await act(async () => resolveNew([{ ...role, id: 'new-generation' }]));
        expect(renderer.root.findByProps({ testID: 'composer-context-item-agent-role:new-generation' })).toBeTruthy();
        expect(mocks.list).toHaveBeenCalledTimes(2);
    });
    it('hides cached roles and does not query again after logout starts', async () => {
        await render();
        await act(async () => clearFirstSubmissionScope());
        expect(renderer.root.findAllByProps({ testID: `composer-context-item-agent-role:${role.id}` })).toHaveLength(0);
        expect(mocks.list).toHaveBeenCalledTimes(1);
    });
    it('waits for the socket and reads once when connection is established', async () => {
        mocks.status = 'connecting'; await render();
        expect(mocks.list).not.toHaveBeenCalled();
        mocks.status = 'connected'; await render();
        expect(row()).toBeTruthy(); expect(mocks.list).toHaveBeenCalledTimes(1);
        mocks.status = 'disconnected'; await render();
        expect(renderer.root.findAllByProps({ testID: `composer-context-item-agent-role:${role.id}` })).toHaveLength(0);
        mocks.status = 'connected'; await render();
        expect(row()).toBeTruthy(); expect(mocks.list).toHaveBeenCalledTimes(2);
    });
});
