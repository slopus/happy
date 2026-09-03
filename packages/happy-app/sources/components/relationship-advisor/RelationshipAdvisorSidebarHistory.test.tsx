import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelationshipAdvisorSidebarHistory } from './RelationshipAdvisorSidebarHistory';
import type { RelationshipAdvisorConversation } from './relationshipAdvisorHistoryModel';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    conversations: [{
        id: 'conversation-1',
        title: '她只回了哈哈',
        createdAt: 1,
        updatedAt: 2,
        messages: [{ id: 'user-1', role: 'user' as const, text: '她只回了哈哈', createdAt: 2, imageCount: 0 }],
    }] as RelationshipAdvisorConversation[],
    params: { conversationId: 'conversation-1' } as { conversationId?: string },
    pathname: '/relationship-advisor',
    updateConversations: vi.fn(),
    confirm: vi.fn(),
}));

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'new-conversation-id' }));
vi.mock('expo-router', () => ({
    useGlobalSearchParams: () => mocks.params,
    usePathname: () => mocks.pathname,
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                text: '#111',
                textSecondary: '#666',
                surfacePressed: '#eee',
                surfaceSelected: '#ddd',
            },
        }),
    },
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#666' } } }),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { confirm: (...args: unknown[]) => mocks.confirm(...args) } }));
vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => mocks.conversations,
    useLocalSettingUpdater: () => mocks.updateConversations,
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('RelationshipAdvisorSidebarHistory', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.conversations = [{
            id: 'conversation-1',
            title: '她只回了哈哈',
            createdAt: 1,
            updatedAt: 2,
            messages: [{ id: 'user-1', role: 'user' as const, text: '她只回了哈哈', createdAt: 2, imageCount: 0 }],
        }];
        mocks.params = { conversationId: 'conversation-1' };
        mocks.pathname = '/relationship-advisor';
        mocks.confirm.mockResolvedValue(true);
        mocks.updateConversations.mockImplementation((updater: (value: typeof mocks.conversations) => typeof mocks.conversations) => {
            mocks.conversations = updater(mocks.conversations);
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('creates and opens a persistent conversation from the sidebar', () => {
        const onNavigate = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<RelationshipAdvisorSidebarHistory onNavigate={onNavigate} />);
        });

        act(() => renderer.root.findByProps({ testID: 'relationship-advisor-new-conversation' }).props.onPress());

        expect(mocks.conversations).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'new-conversation-id', title: 'relationshipAdvisor.newConversation' }),
        ]));
        expect(onNavigate).toHaveBeenCalledWith('/relationship-advisor?conversationId=new-conversation-id');
        act(() => renderer.unmount());
    });

    it('deletes the last current conversation and returns to the empty index', async () => {
        const onNavigate = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<RelationshipAdvisorSidebarHistory onNavigate={onNavigate} />);
        });
        const row = renderer.root.findByProps({ testID: 'relationship-advisor-history-conversation-1' });
        const deleteButton = row.findAllByType('Pressable').find((node: any) => (
            node.props.accessibilityLabel === 'relationshipAdvisor.deleteConversationAccessibility'
        ));

        await act(async () => deleteButton.props.onPress());

        expect(mocks.confirm).toHaveBeenCalledOnce();
        expect(mocks.conversations).toEqual([]);
        expect(onNavigate).toHaveBeenCalledWith('/relationship-advisor');
        act(() => renderer.unmount());
    });

    it('keeps navigation and delete as sibling actions', () => {
        const onNavigate = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<RelationshipAdvisorSidebarHistory onNavigate={onNavigate} />);
        });
        const row = renderer.root.findByProps({ testID: 'relationship-advisor-history-conversation-1' });
        const actions = row.findAllByType('Pressable');

        expect(actions).toHaveLength(2);
        expect(actions[0].findAllByType('Pressable')).toHaveLength(1);
        act(() => actions[0].props.onPress());
        expect(onNavigate).toHaveBeenCalledWith('/relationship-advisor?conversationId=conversation-1');
        act(() => renderer.unmount());
    });

    it('uses the localized new-conversation label when a migrated title is empty', () => {
        mocks.conversations = [{
            id: 'conversation-1',
            title: '',
            createdAt: 1,
            updatedAt: 2,
            messages: [],
        }];
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<RelationshipAdvisorSidebarHistory onNavigate={vi.fn()} />);
        });

        const row = renderer.root.findByProps({ testID: 'relationship-advisor-history-conversation-1' });
        expect(row.findAllByType('Text').some((node: any) => (
            node.props.children === 'relationshipAdvisor.newConversation'
        ))).toBe(true);
        act(() => renderer.unmount());
    });

    it('deletes from the latest history after confirmation without rolling back another conversation', async () => {
        let resolveConfirm: (confirmed: boolean) => void = () => undefined;
        mocks.conversations = [
            ...mocks.conversations,
            { id: 'conversation-2', title: 'Second', createdAt: 3, updatedAt: 3, messages: [] },
        ];
        mocks.confirm.mockReturnValue(new Promise<boolean>((resolve) => {
            resolveConfirm = resolve;
        }));
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<RelationshipAdvisorSidebarHistory onNavigate={vi.fn()} />);
        });
        const secondRow = renderer.root.findByProps({ testID: 'relationship-advisor-history-conversation-2' });
        const deleteButton = secondRow.findAllByType('Pressable').find((node: any) => (
            node.props.accessibilityLabel === 'relationshipAdvisor.deleteConversationAccessibility'
        ));

        let deletion: Promise<void>;
        act(() => {
            deletion = deleteButton.props.onPress();
        });
        mocks.conversations = mocks.conversations.map((conversation) => conversation.id === 'conversation-1'
            ? {
                ...conversation,
                messages: [...conversation.messages, {
                    id: 'assistant-late',
                    role: 'assistant' as const,
                    text: '刚刚完成的回复',
                    createdAt: 4,
                    imageCount: 0,
                }],
            }
            : conversation);
        await act(async () => {
            resolveConfirm(true);
            await deletion!;
        });

        expect(mocks.conversations.map(({ id }) => id)).toEqual(['conversation-1']);
        expect(mocks.conversations[0]?.messages.at(-1)?.id).toBe('assistant-late');
        act(() => renderer.unmount());
    });
});
