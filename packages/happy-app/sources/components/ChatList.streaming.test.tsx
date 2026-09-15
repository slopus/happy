import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import type { Message } from '@/sync/typesMessage';
import type { Session } from '@/sync/storageTypes';
import type { SessionTextPreview } from '@/sync/sessionTextStream';
import { ChatList } from './ChatList';

const state = vi.hoisted(() => ({
    messages: [] as Message[], previews: [] as SessionTextPreview[], isAtLatest: true,
}));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Platform: { OS: 'web' } }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: any) => factory({ colors: { text: 'theme-text' } }) },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 0 }));
vi.mock('@/sync/storage', () => ({
    useSession: (id: string) => ({ id, thinking: true, metadata: null }),
    useSessionMessages: () => ({ ...state, isLoaded: true }),
    useSetting: () => true,
}));
vi.mock('@/sync/sessionTextStream', () => ({ useSessionTextPreviews: () => state.previews }));
vi.mock('@/sync/sync', () => ({ sync: { getLocalHistoryScope: () => null, getHistoryBoundarySeq: () => null } }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => ({}) }));
vi.mock('@/hooks/useGroupedMessages', () => ({ isSessionTurnActive: () => true }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('./ChatFooter', () => ({ ChatFooter: () => null }));
// The native list/scroll machinery is tested by ConversationTranscript.pagination;
// keep this boundary lightweight while rendering the real ChatList live-text subtree.
vi.mock('./ConversationTranscript', () => ({ ConversationTranscript: (props: any) => <>
    {props.messages.map((message: Message) => message.kind === 'agent-text'
        ? React.createElement('Text', { key: message.id }, message.text) : null)}
    {props.visualBottom}
</> }));

const session = { id: 'session-a', metadata: null } as Session;
const preview = { sessionId: session.id, turnId: 'turn', itemId: 'item', text: 'First', createdAt: 1 };

describe('ChatList streaming output', () => {
    let renderer: any;
    beforeEach(() => {
        state.messages = []; state.previews = []; state.isAtLatest = true;
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const originalError = console.error;
        vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
            if (args[0]?.startsWith?.('react-test-renderer is deprecated')) return;
            originalError(...args);
        });
    });
    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined; vi.restoreAllMocks();
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });
    const visibleText = () => renderer.root.findAllByType('Text').map((node: any) => node.props.children);
    const render = (id = session.id) => act(() => {
        const element = <ChatList session={{ ...session, id }} />;
        if (renderer) renderer.update(element); else renderer = TestRenderer.create(element);
    });

    it('shows the first chunk immediately and replaces cumulative text without replaying old chunks', () => {
        state.previews = [preview]; render();
        expect(visibleText()).toEqual(['First']);
        state.previews = [{ ...preview, text: 'First second' }]; render();
        expect(visibleText()).toEqual(['First second']);
    });

    it('renders only the durable answer during the final-message/store-cleanup handoff', () => {
        state.previews = [preview]; render();
        state.messages = [{ kind: 'agent-text', id: 'final', localId: null, createdAt: 2,
            text: 'Final answer', streamKey: { turnId: 'turn', itemId: 'item' } }];
        render();
        expect(visibleText()).toEqual(['Final answer']);
        state.previews = []; render();
        expect(visibleText()).toEqual(['Final answer']);
    });

    it('hides live output when reading a historical window and after switching sessions', () => {
        state.previews = [preview]; render();
        expect(visibleText()).toEqual(['First']);
        state.isAtLatest = false; render();
        expect(visibleText()).toEqual([]);
        state.isAtLatest = true; render('session-b');
        expect(visibleText()).toEqual([]);
    });

    it('renders structured payloads as selectable text without temporary message actions', () => {
        const payload = '<happy-ota-preview>pending</happy-ota-preview>\n<options><option>Run</option></options>';
        state.previews = [{ ...preview, text: payload }]; render();
        expect(visibleText()).toEqual([payload]);
        expect(renderer.root.findAllByType('Text')[0].props.selectable).toBe(true);
        expect(renderer.root.findAll((node: any) => typeof node.props.onPress === 'function')).toEqual([]);
    });
});
