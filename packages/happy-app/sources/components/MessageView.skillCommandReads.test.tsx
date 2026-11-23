import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { MessageView } from './MessageView';

// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator', Image: 'Image',
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('./DesktopDialogFrame', () => ({ DesktopDialogFrame: 'DesktopDialogFrame' }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('./tools/ToolView', () => ({ ToolView: 'ToolView' }));
vi.mock('./SkillBrowserProgress', () => ({ SkillBrowserProgress: () => null }));
vi.mock('./subagent/SubagentInspectorContext', () => ({ useSubagentInspector: () => null }));
vi.mock('./DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: 'DesktopShortcutTooltip' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 900 } }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => {
    const nestedTheme = new Proxy({}, {
        get: (_target, property) => property === 'toString' ? () => '#000000' : nestedTheme,
    });
    return {
        StyleSheet: { hairlineWidth: 1, create: (factory: (theme: object) => object) => factory({ colors: nestedTheme }) },
        useUnistyles: () => ({ theme: { colors: nestedTheme } }),
    };
});

function commandMessage(state: ToolCallMessage['tool']['state'] = 'completed'): ToolCallMessage {
    return {
        kind: 'tool-call', id: 'command-one', localId: null, createdAt: 1, children: [],
        tool: {
            name: 'CodexBash',
            input: { command: ['/bin/zsh', '-lc', 'git status --short; cat /skills/ego-ops/SKILL.md; cat /skills/ego-browser/SKILL.md'] },
            state, createdAt: 1, startedAt: 1, completedAt: state === 'running' ? null : 2, description: null,
        },
    };
}

describe('MessageView Skill command-read integration', () => {
    let renderer: any;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); });
    const render = (message: ToolCallMessage) => {
        act(() => { renderer = TestRenderer.create(<MessageView message={message} metadata={null} sessionId="session-one" />); });
    };
    const texts = () => renderer.root.findAllByType('Text').map((node: any) => node.children.join(''));

    it.each([
        ['running', 'running'],
        ['completed', 'completed'],
        ['error', 'failed'],
        ['cancelled', 'cancelled'],
    ] as const)('adds the Skill batch with its %s command status while preserving the raw terminal', (state, expected) => {
        const message = commandMessage(state);
        if (state === 'error') message.tool.failure = { summary: 'git: repository unavailable' };
        render(message);

        const originalTerminal = renderer.root.findByType('ToolView');
        expect(originalTerminal.props.tool).toBe(message.tool);
        expect(originalTerminal.props).toMatchObject({ messageId: 'command-one', sessionId: 'session-one' });
        expect(texts()).toContain('ego-ops, ego-browser');
        expect(texts()).toContain('toolGroup.skillBatchLabel');
        expect(texts()).toContain(`toolGroup.skillCommandStatus.${expected}`);
        expect(texts()).not.toContain('toolGroup.skillDocumentStatus.failed');
        expect(texts()).not.toContain('toolGroup.skillFailureNoDetails');
        if (state === 'error') {
            expect(originalTerminal.props.tool.failure).toBe(message.tool.failure);
            expect(texts()).not.toContain('git: repository unavailable');
        }
    });

    it('keeps pending command permission in the original terminal without adding a premature Skill batch', () => {
        const message = commandMessage('running');
        message.tool.permission = { id: 'permission-one', status: 'pending' };
        render(message);
        expect(renderer.root.findByType('ToolView').props.tool.permission).toBe(message.tool.permission);
        expect(texts()).not.toContain('ego-ops, ego-browser');
        expect(texts()).not.toContain('toolGroup.skillBatchLabel');
    });
});
