import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import type { DelegatedTaskSummary } from '@slopus/happy-wire';
import type { Message } from '@/sync/typesMessage';
import { ChatList } from './ChatList';

const state = vi.hoisted(() => ({
    messages: [] as Message[], sessions: {} as Record<string, any>, groupTools: true,
    isAtLatest: true, active: false, sections: [] as any[],
}));
vi.mock('react-native', () => ({
    AppState: { addEventListener: () => ({ remove: vi.fn() }) },
    FlatList: (props: any) => <>{props.ListHeaderComponent}{props.data.map((item: any) =>
        <React.Fragment key={props.keyExtractor(item)}>{props.renderItem({ item })}</React.Fragment>)}{props.ListFooterComponent}</>,
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable',
    ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: 1200, height: 800, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: any) => typeof factory === 'function'
        ? factory({ colors: { divider: 'divider', text: 'text', textSecondary: 'secondary', shadow: {}, fab: {} } }) : factory },
    useUnistyles: () => ({ theme: { colors: {} } }),
}));
vi.mock('react-native-reanimated', () => ({ default: { View: 'AnimatedView' },
    FadeIn: { duration: vi.fn() }, FadeOut: { duration: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Octicons: 'Octicons' }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 0 }));
vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => 'default', useProfile: () => ({ id: 'user' }),
    useSetting: () => state.groupTools, useSession: (id: string) => state.sessions[id],
    useSessionMessages: () => ({ messages: state.messages, isLoaded: true, isAtLatest: state.isAtLatest }),
}));
vi.mock('@/sync/sessionTextStream', () => ({ useSessionTextPreviews: () => [] }));
vi.mock('@/sync/sync', () => ({ sync: {
    getLocalHistoryScope: () => null, getHistoryBoundarySeq: () => null,
    getMessageWireId: (_session: string, id: string) => id,
    getMessageWireSeq: () => null, getMessageWireBlockKey: () => null,
} }));
vi.mock('@/hooks/useContinuationHistory', () => ({ useContinuationHistory: () => ({
    sections: state.sections, isAtLatest: state.isAtLatest,
}) }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => ({}) }));
vi.mock('@/utils/messageForkPoint', () => ({ getAgentMessageForkTargets: () => new Map() }));
vi.mock('@/modal/components/BaseModal', () => ({ BaseModal: 'BaseModal' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./tools/knownTools', () => ({ knownTools: {} }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('./MessageView', () => ({ MessageView: ({ message }: any) => React.createElement('MessageRow', { id: message.id }) }));
vi.mock('./ToolGroupView', () => ({
    AgentWorkGroupView: ({ group }: any) => React.createElement('WorkRow', { id: group.id }),
    ToolGroupView: ({ group }: any) => React.createElement('WorkRow', { id: group.id }),
}));
vi.mock('./AttachmentGalleryView', () => ({ AttachmentGalleryView: 'AttachmentGalleryView' }));
vi.mock('./AnchorListSheet', () => ({ AnchorListSheet: 'AnchorListSheet' }));
vi.mock('./haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('./ChatFooter', () => ({ ChatFooter: () => null }));
// Keep the real ChatList, transcript and grouping; card presentation and its
// inspector have their own component suite. This boundary checks visual order.
vi.mock('./delegation/DelegatedTaskGroup', () => ({ DelegatedTaskGroup: ({ sessionId, tasks }: any) => <>
    {(tasks ?? state.sessions[sessionId]?.metadata?.delegatedTasks ?? []).map((task: DelegatedTaskSummary) =>
        React.createElement('TaskRow', { key: task.id, id: task.id, status: task.status, sessionId }))}
</> }));

const user = (id: string, createdAt: number): Message => ({ kind: 'user-text', id, createdAt, localId: null, text: id });
const answer = (id: string, createdAt: number): Message => ({ kind: 'agent-text', id, createdAt, localId: null, text: id });
const tool = (id: string, createdAt: number): Message => ({ kind: 'tool-call', id, createdAt, localId: null, children: [],
    tool: { name: 'McpTool', input: {}, state: 'completed', createdAt, startedAt: createdAt, completedAt: createdAt + 10, description: null } });
const task = (id: string, startedAt: number, parentSessionId = 'parent'): DelegatedTaskSummary => ({
    id, parentSessionId, title: id, roleName: 'Writer', agent: 'antigravity', version: 1,
    startedAt, updatedAt: startedAt + 20, finishedAt: startedAt + 20, status: 'completed', resultAvailable: true,
});

describe('delegated task placement in the real chat transcript', () => {
    let renderer: any;
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        state.messages = [answer('final', 200), tool('delegate', 110), user('prompt', 100)];
        state.sessions = { parent: { id: 'parent', active: false, metadata: { delegatedTasks: [task('child', 111)] } } };
        state.groupTools = true; state.isAtLatest = true; state.active = false; state.sections = [];
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });
    const render = () => act(() => {
        const element = <ChatList session={state.sessions.parent} />;
        if (renderer) renderer.update(element); else renderer = TestRenderer.create(element);
    });
    const rows = () => renderer.root.findAll((node: any) => ['MessageRow', 'WorkRow', 'TaskRow'].includes(node.type)).map((node: any) => node.props.id);

    it.each([true, false])('shows the child during its work, before the final answer (grouping=%s)', grouping => {
        state.groupTools = grouping; render();
        expect(rows()).toEqual(['prompt', grouping ? 'work-delegate' : 'delegate', 'child', 'final']);
    });

    it('keeps each task with its own parent turn instead of collecting tasks after the latest answer', () => {
        state.messages = [answer('final-2', 400), tool('delegate-2', 310), user('prompt-2', 300), ...state.messages];
        state.sessions.parent.metadata.delegatedTasks.push(task('child-2', 311)); render();
        expect(rows()).toEqual(['prompt', 'work-delegate', 'child', 'final', 'prompt-2', 'work-delegate-2', 'child-2', 'final-2']);
    });

    it('updates task status without moving the card past the final answer', () => {
        state.sessions.parent.metadata.delegatedTasks[0] = { ...task('child', 111), status: 'running', finishedAt: undefined };
        render(); const before = rows();
        state.sessions.parent = { ...state.sessions.parent, metadata: { delegatedTasks: [task('child', 111)] } }; render();
        expect(rows()).toEqual(before);
        expect(renderer.root.findByType('TaskRow').props.status).toBe('completed');
        expect(rows().indexOf('child')).toBeLessThan(rows().indexOf('final'));
    });

    it('keeps historical tasks visible in their loaded window while excluding newer and older unloaded tasks', () => {
        state.isAtLatest = false;
        state.sessions.parent.metadata.delegatedTasks.push(task('unloaded-newer', 311), task('unloaded-older', 11)); render();
        expect(rows()).toEqual(['prompt', 'work-delegate', 'child', 'final']);
    });

    it('shows a starting task before its next provider message arrives', () => {
        state.messages = state.messages.slice(1);
        state.sessions.parent = { ...state.sessions.parent, active: true, thinking: true,
            metadata: { delegatedTasks: [{ ...task('child', 111), status: 'starting', finishedAt: undefined }] } };
        render();
        expect(rows()).toEqual(['prompt', 'group-delegate', 'child']);
    });

    it('includes work inside a loaded long tool at a historical window boundary', () => {
        state.isAtLatest = false;
        state.messages = [tool('wrapper', 110), user('prompt', 100)];
        if (state.messages[0].kind === 'tool-call') state.messages[0].tool.completedAt = 180;
        state.sessions.parent.metadata.delegatedTasks.push(task('unloaded-newer', 190)); render();
        expect(rows()).toEqual(['prompt', 'group-wrapper', 'child']);
    });

    it('keeps same-role concurrent tasks in start order within the owning work group', () => {
        state.sessions.parent.metadata.delegatedTasks = [task('second', 113), task('first', 111)]; render();
        expect(rows()).toEqual(['prompt', 'work-delegate', 'first', 'second', 'final']);
    });

    it('places a revision by its own start without altering the original task timestamps', () => {
        const original = task('child', 111);
        const revision = { ...original, version: 2, startedAt: 311, updatedAt: 320, finishedAt: 320 };
        state.messages = [answer('final-2', 400), tool('revise', 310), user('prompt-2', 300), ...state.messages];
        state.sessions.parent.metadata.delegatedTasks = [revision]; render();
        expect(rows()).toEqual(['prompt', 'work-delegate', 'final', 'prompt-2', 'work-revise', 'child', 'final-2']);
        expect(original.startedAt).toBe(111);
    });

    it('anchors continuation tasks using each source session even when message IDs overlap', () => {
        const oldMessages = [answer('final', 50), tool('delegate', 20), user('prompt', 10)];
        state.sessions.old = { id: 'old', metadata: { delegatedTasks: [task('old-child', 21, 'old')] } };
        state.sessions.parent.metadata.continuationOfSessionId = 'old';
        state.sections = [
            { id: 'parent', messages: state.messages, metadata: state.sessions.parent.metadata },
            { id: 'old', messages: oldMessages, metadata: state.sessions.old.metadata },
        ];
        render();
        const children = renderer.root.findAllByType('TaskRow');
        expect(children.map((node: any) => [node.props.id, node.props.sessionId])).toEqual([['old-child', 'old'], ['child', 'parent']]);
        expect(rows().indexOf('old-child')).toBeLessThan(rows().indexOf('child'));
    });

    it('uses authoritative V2 tasks and rejects a foreign parent task', () => {
        state.sessions.parent.metadata.delegationV2 = { version: 2, roles: [], tasks: [task('foreign', 111, 'other')] }; render();
        expect(rows()).toEqual(['prompt', 'work-delegate', 'final']);
    });
});
