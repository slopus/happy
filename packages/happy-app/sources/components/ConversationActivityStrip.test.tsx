import * as React from 'react';
import { act } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { SubagentInspectorProvider, useSubagentInspector } from './subagent/SubagentInspectorContext';
import { ConversationActivityStrip } from './ConversationActivityStrip';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface below.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
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

function toolMessage(id: string, name: string, input: Record<string, unknown>, children: Message[] = []): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: Number(id),
        tool: {
            name,
            input,
            state: 'completed',
            createdAt: Number(id),
            startedAt: Number(id),
            completedAt: Number(id),
            description: null,
        },
        children,
    };
}

describe('ConversationActivityStrip', () => {
    beforeAll(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('opens subagent rows as accessible buttons while leaving Skill rows static', () => {
        let selectedId: string | null = null;
        function SelectionProbe() {
            selectedId = useSubagentInspector()?.selection?.id ?? null;
            return null;
        }

        const messages = [
            toolMessage('1', 'Skill', { skillName: 'tdd' }),
            toolMessage('2', 'Agent', {
                sessionSubagent: 'agent-one',
                description: 'Implementation agent',
            }),
        ];
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SubagentInspectorProvider sessionId="session-one">
                    <ConversationActivityStrip messages={messages} />
                    <SelectionProbe />
                </SubagentInspectorProvider>,
            );
        });

        const skillRow = renderer.root.findByProps({ testID: 'activity-skill-tdd' });
        expect(skillRow.type).toBe('View');
        expect(skillRow.props.onPress).toBeUndefined();

        let subagentRow = renderer.root.findByProps({ testID: 'activity-subagent-agent-one' });
        expect(subagentRow.type).toBe('Pressable');
        expect(subagentRow.props.accessibilityRole).toBe('button');
        expect(subagentRow.props.accessibilityLabel).toBe('toolGroup.openSubagentDetails:Implementation agent');
        expect(subagentRow.props.accessibilityState).toEqual({ expanded: false });
        expect(subagentRow.props['aria-expanded']).toBe(false);
        expect(subagentRow.props.style({ pressed: false })).toContainEqual(
            expect.objectContaining({ flexDirection: 'row', alignItems: 'center' }),
        );

        act(() => subagentRow.props.onPress());
        expect(selectedId).toBe('agent-one');
        subagentRow = renderer.root.findByProps({ testID: 'activity-subagent-agent-one' });
        expect(subagentRow.props.accessibilityState).toEqual({ expanded: true });

        act(() => renderer.unmount());
    });

    it('shows a failed Skill summary and expands its diagnostic detail', () => {
        const failedSkill = toolMessage('1', 'Skill', { skillName: 'gpt-image-2' });
        failedSkill.tool.state = 'error';
        failedSkill.tool.failure = {
            summary: 'Skill file was not found.',
            detail: 'sed: /plugins/gpt-image-2/SKILL.md: No such file or directory',
        };

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ConversationActivityStrip messages={[failedSkill]} />);
        });

        let skillRow = renderer.root.findByProps({ testID: 'activity-skill-gpt-image-2' });
        expect(skillRow.type).toBe('Pressable');
        expect(skillRow.props.accessibilityLabel).toBe('toolGroup.openSkillDetails:gpt-image-2');
        expect(skillRow.props.accessibilityState).toEqual({ expanded: false });
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join('')))
            .toContain('Skill file was not found.');
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join('')))
            .not.toContain('sed: /plugins/gpt-image-2/SKILL.md: No such file or directory');

        act(() => skillRow.props.onPress());
        skillRow = renderer.root.findByProps({ testID: 'activity-skill-gpt-image-2' });
        expect(skillRow.props.accessibilityLabel).toBe('toolGroup.closeSkillDetails:gpt-image-2');
        expect(skillRow.props.accessibilityState).toEqual({ expanded: true });
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join('')))
            .toContain('sed: /plugins/gpt-image-2/SKILL.md: No such file or directory');

        act(() => renderer.unmount());
    });

    it('keeps summary-only failed Skills non-interactive', () => {
        const failedSkill = toolMessage('1', 'Skill', { skillName: 'gpt-image-2' });
        failedSkill.tool.state = 'error';
        failedSkill.tool.failure = { summary: 'Skill file was not found.' };

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ConversationActivityStrip messages={[failedSkill]} />);
        });

        const skillRow = renderer.root.findByProps({ testID: 'activity-skill-gpt-image-2' });
        expect(skillRow.type).toBe('View');
        expect(skillRow.props.onPress).toBeUndefined();
        expect(renderer.root.findAllByType('Ionicons').map((node: any) => node.props.name))
            .not.toContain('chevron-down');

        act(() => renderer.unmount());
    });

    it('keeps failed Skills without diagnostics non-interactive', () => {
        const failedSkill = toolMessage('1', 'Skill', { skillName: 'gpt-image-2' });
        failedSkill.tool.state = 'error';

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ConversationActivityStrip messages={[failedSkill]} />);
        });

        const skillRow = renderer.root.findByProps({ testID: 'activity-skill-gpt-image-2' });
        expect(skillRow.type).toBe('View');
        expect(skillRow.props.onPress).toBeUndefined();
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join('')))
            .toContain('toolGroup.skillFailureNoDetails');

        act(() => renderer.unmount());
    });
});
