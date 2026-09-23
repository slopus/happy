import * as React from 'react';
import { act } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { SubagentInspectorProvider, useSubagentInspector } from './subagent/SubagentInspectorContext';
import { ConversationActivityStrip } from './ConversationActivityStrip';
import { BrowserProgressContext } from './BrowserProgressContext';
import { getBrowserStepRuns } from './rightPanel/browserStepRunsModel';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface below.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('./rightPanel/BrowserStepsPopover', () => ({ BrowserStepsPopover: 'BrowserStepsPopover' }));
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
    it('keeps a stable inner scroll anchor when older activities change the display order', () => {
        const skill = toolMessage('2', 'Skill', { skill: 'ego-browser' });
        const older = toolMessage('1', 'Skill', { skill: 'systematic-debugging' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ConversationActivityStrip messages={[skill]} />); });
        const anchor = () => renderer.root.findByProps({ testID: 'activity-skill-ego-browser' }).props.dataSet.transcriptActivity;
        const before = anchor();
        expect(before).toContain('skill');
        act(() => renderer.update(<ConversationActivityStrip messages={[older, skill]} />));
        expect(anchor()).toBe(before);
        expect(renderer.root.findAll((node: any) => node.props.testID?.startsWith('activity-skill-'))).toHaveLength(2);
        act(() => renderer.unmount());
    });
    it('keeps an open Skill preview mounted when older history changes its sorting position', () => {
        const skill = toolMessage('2', 'Skill', { skill: 'ego-browser' });
        const frame = toolMessage('3', 'file', { source: 'browser_step', ref: 'attachment://3', name: '3.png',
            browserStep: { label: 'Verified', runId: 'stable-run', skillName: 'ego-browser' } });
        const older = toolMessage('1', 'Skill', { skill: 'systematic-debugging' });
        const runs = getBrowserStepRuns([skill, frame]);
        const render = (messages: Message[]) => <BrowserProgressContext.Provider value={{ sessionId: 'stable-session', runs }}>
            <ConversationActivityStrip messages={messages} />
        </BrowserProgressContext.Provider>;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(render([skill])); });
        act(() => renderer.root.findByProps({ testID: 'browser-progress-trigger-stable-run' }).props.onPress());
        expect(renderer.root.findAllByType('BrowserStepsPopover')).toHaveLength(1);
        act(() => renderer.update(render([older, skill])));
        expect(renderer.root.findAllByType('BrowserStepsPopover')).toHaveLength(1);
        act(() => renderer.unmount());
    });

    it('opens each repeated Ego invocation from the inline Skills row and receives later frames', () => {
        const first = toolMessage('1', 'Skill', { skill: 'ego-browser' });
        const second = toolMessage('3', 'Skill', { skillNames: ['ego-browser'] });
        const frame = (id: string, runId: string) => toolMessage(id, 'file', {
            source: 'browser_step', ref: `attachment://${id}`, name: `${id}.png`,
            browserStep: { label: `Verified ${id}`, runId, skillName: 'ego-browser' },
        });
        const messages = [first, frame('2', 'run-a'), second, frame('4', 'run-b')];
        let renderer: any;
        const render = (all: Message[], sessionId = 's1') => <BrowserProgressContext.Provider value={{ sessionId, runs: getBrowserStepRuns(all) }}>
            <ConversationActivityStrip messages={[first, second]} />
        </BrowserProgressContext.Provider>;
        act(() => { renderer = TestRenderer.create(render(messages)); });
        const row = renderer.root.findByProps({ testID: 'activity-skill-ego-browser' });
        expect(row.findAllByType('Pressable')).toHaveLength(2);
        act(() => renderer.root.findByProps({ testID: 'browser-progress-trigger-run-a' }).props.onPress());
        expect(renderer.root.findByType('BrowserStepsPopover').props.steps.map((s: any) => s.id)).toEqual(['2']);
        act(() => renderer.update(render([...messages, frame('5', 'run-a')])));
        expect(renderer.root.findByType('BrowserStepsPopover').props.steps.map((s: any) => s.id)).toEqual(['2', '5']);
        act(() => renderer.root.findByType('BrowserStepsPopover').props.onClose());
        expect(renderer.root.findAllByType('BrowserStepsPopover')).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'browser-progress-trigger-run-b' }).props.onPress());
        expect(renderer.root.findByType('BrowserStepsPopover').props.steps.map((s: any) => s.id)).toEqual(['4']);
        act(() => renderer.update(render(messages, 's2')));
        expect(renderer.root.findAllByType('BrowserStepsPopover')).toHaveLength(0);
        act(() => renderer.unmount());
    });
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

    it('labels a failed batch once and shows its actionable diagnostic', () => {
        const batch = toolMessage('1', 'Skill', { skillNames: ['dev', 'workflow'] });
        batch.tool.state = 'error';
        batch.tool.result = '---\nname: dev\n---\nsed: /skills/workflow/SKILL.md: No such file or directory';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ConversationActivityStrip messages={[batch]} />); });
        const texts = renderer.root.findAllByType('Text').map((node: any) => node.children.join(''));
        expect(texts.filter((text: string) => text === 'toolGroup.skillBatchLabel')).toHaveLength(1);
        expect(texts).toContain('dev, workflow');
        expect(texts).toContain('sed: /skills/workflow/SKILL.md: No such file or directory');
        expect(renderer.root.findAllByProps({ testID: 'activity-skill-dev' })).toHaveLength(0);
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
