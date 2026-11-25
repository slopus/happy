import * as React from 'react';
import { act } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { ConversationActivityStrip } from './ConversationActivityStrip';
vi.mock('./subagent/SubagentActivityGroup', () => ({ SubagentActivityGroup: 'SubagentActivityGroup' }));

// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('./SkillBrowserProgress', () => ({ SkillBrowserProgress: () => null }));
vi.mock('./subagent/SubagentInspectorContext', () => ({ useSubagentInspector: () => null }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (theme: object) => object)({
                colors: {
                    success: '#00ff00',
                    box: { error: { background: '#330000', border: '#aa0000', text: '#ff7777' } },
                    surfaceHigh: '#222222',
                    surfaceHighest: '#333333',
                    text: '#ffffff',
                    textDestructive: '#ff0000',
                    textSecondary: '#aaaaaa',
                    warning: '#ffaa00',
                },
            })
            : factory,
    },
    useUnistyles: () => ({
        theme: { colors: {
            success: '#00ff00',
            textDestructive: '#ff0000',
            textSecondary: '#aaaaaa',
            warning: '#ffaa00',
        } },
    }),
}));
vi.mock('@/text', () => ({
    t: (key: string, values?: { title?: string }) => values?.title ? `${key}:${values.title}` : key,
}));

function toolMessage(
    id: number,
    name: string,
    input: Record<string, unknown>,
    state: ToolCallMessage['tool']['state'] = 'completed',
): ToolCallMessage {
    return {
        kind: 'tool-call', id: String(id), localId: null, createdAt: id, children: [],
        tool: {
            name, input, state, createdAt: id, startedAt: id,
            completedAt: state === 'running' ? null : id, description: null,
        },
    };
}

function renderedTexts(messages: Message[]): string[] {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<ConversationActivityStrip messages={messages} />); });
    const texts = renderer.root.findAllByType('Text').map((node: any) => node.children.join(''));
    act(() => renderer.unmount());
    return texts;
}

describe('ConversationActivityStrip Skill document labels', () => {
    beforeAll(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it.each([
        ['running', 'running'],
        ['completed', 'completed'],
        ['error', 'failed'],
        ['cancelled', 'cancelled'],
    ] as const)('describes a %s Read as a document load rather than task completion', (state, status) => {
        const texts = renderedTexts([
            toolMessage(1, 'Read', { file_path: '/skills/photo-to-styled-motion/SKILL.md' }, state),
        ]);
        expect(texts).toContain('photo-to-styled-motion');
        expect(texts).toContain('toolGroup.skillDocumentLabel');
        expect(texts).toContain(`toolGroup.skillDocumentStatus.${status}`);
        expect(texts).not.toContain('toolGroup.skillLabel');
        expect(texts).not.toContain('toolGroup.subagentStatus.completed');
    });

    it('keeps the native Skill label and status alongside a document load of the same Skill', () => {
        const texts = renderedTexts([
            toolMessage(1, 'Read', { file_path: '/skills/photo-to-styled-motion/SKILL.md' }),
            toolMessage(2, 'Skill', { skill: 'photo-to-styled-motion' }),
        ]);
        expect(texts.filter(text => text === 'photo-to-styled-motion')).toHaveLength(2);
        expect(texts).toContain('toolGroup.skillDocumentLabel');
        expect(texts).toContain('toolGroup.skillDocumentStatus.completed');
        expect(texts).toContain('toolGroup.skillLabel');
        expect(texts).toContain('toolGroup.subagentStatus.completed');
    });

    it('does not show a Skill activity for ordinary files', () => {
        expect(renderedTexts([
            toolMessage(1, 'Read', { file_path: '/repo/minimax.py' }),
        ])).toEqual([]);
    });

    it('shows the failed document diagnostic with the load failure status', () => {
        const failedRead = toolMessage(1, 'Read', { file_path: '/skills/local-style/SKILL.md' }, 'error');
        failedRead.tool.failure = { summary: 'Skill document could not be read.' };
        const texts = renderedTexts([failedRead]);
        expect(texts).toContain('toolGroup.skillDocumentStatus.failed');
        expect(texts).toContain('Skill document could not be read.');
        expect(texts).not.toContain('toolGroup.skillDocumentStatus.completed');
    });
});
