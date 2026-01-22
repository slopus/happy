import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllow = vi.fn();
const sessionDeny = vi.fn();
const sendMessage = vi.fn();

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                button: { primary: { background: '#00f', tint: '#fff' } },
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: () => null,
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('../../tools/knownTools', () => ({
    knownTools: {
        ExitPlanMode: {
            input: {
                safeParse: () => ({ success: true, data: { plan: 'plan' } }),
            },
        },
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: (...args: any[]) => sessionAllow(...args),
    sessionDeny: (...args: any[]) => sessionDeny(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: any[]) => sendMessage(...args),
    },
}));

describe('ExitPlanToolView', () => {
    beforeEach(() => {
        sessionAllow.mockReset();
        sessionDeny.mockReset();
        sendMessage.mockReset();
    });

    it('approves via permission RPC and does not send a follow-up user message', async () => {
        const { ExitPlanToolView } = await import('./ExitPlanToolView');

        const tool: ToolCall = {
            name: 'ExitPlanMode',
            state: 'running',
            input: { plan: 'plan' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: { id: 'perm1', status: 'pending' },
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ExitPlanToolView, { tool, sessionId: 's1', metadata: null, messages: [] }),
            );
        });

        const buttons = tree!.root.findAllByType('TouchableOpacity' as any);
        expect(buttons.length).toBeGreaterThanOrEqual(2);

        await act(async () => {
            await buttons[1].props.onPress();
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('rejects via permission RPC and does not send a follow-up user message', async () => {
        const { ExitPlanToolView } = await import('./ExitPlanToolView');

        const tool: ToolCall = {
            name: 'ExitPlanMode',
            state: 'running',
            input: { plan: 'plan' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: { id: 'perm1', status: 'pending' },
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ExitPlanToolView, { tool, sessionId: 's1', metadata: null, messages: [] }),
            );
        });

        const buttons = tree!.root.findAllByType('TouchableOpacity' as any);
        expect(buttons.length).toBeGreaterThanOrEqual(2);

        await act(async () => {
            await buttons[0].props.onPress();
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });
});
