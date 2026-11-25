import * as React from 'react';
import { act } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { AgentWorkGroupView } from './ToolGroupView';

// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    Pressable: 'Pressable', Text: 'Text', View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('./codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
vi.mock('./MessageView', () => ({ MessageView: 'MessageView' }));
vi.mock('./tools/knownTools', () => ({ knownTools: {} }));
vi.mock('./tools/views/MCPToolView', () => ({ formatMCPTitle: (name: string) => name }));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 0 }));
vi.mock('@/hooks/useOpenSessionFile', () => ({ useOpenSessionFile: () => vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./SkillBrowserProgress', () => ({ SkillBrowserProgress: () => null }));
vi.mock('./subagent/SubagentInspectorContext', () => ({ useSubagentInspector: () => null }));
vi.mock('./layout', () => ({ layout: { maxWidth: 900 } }));
vi.mock('@/text', () => ({
    t: (key: string, values?: { duration?: string }) => key === 'toolGroup.workedFor'
        ? `Worked ${values?.duration}` : key,
}));
vi.mock('react-native-unistyles', () => {
    const colors = new Proxy({}, {
        get: (_target, property) => property === 'toString' ? () => '#000000' : colors,
    });
    return {
        StyleSheet: { create: (factory: (theme: object) => object) => factory({ colors }) },
        useUnistyles: () => ({ theme: { colors } }),
    };
});

function tool(id: number, name: string, input: Record<string, unknown>): ToolCallMessage {
    return {
        kind: 'tool-call', id: String(id), localId: null, createdAt: id, children: [],
        tool: { name, input, state: 'completed', createdAt: id, startedAt: id, completedAt: id, description: null },
    };
}

describe('collapsed Worked summary Skill completeness', () => {
    beforeAll(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('shows terminal Skill reads, native Ego and both subagents without expanding the work group', () => {
        const mixed = [
            'git status --short',
            'cat "/Users/example/skills/release-ops/SKILL.md"',
            'cat "/Users/example/skills/confirmation-ops/SKILL.md"',
        ].join('\n');
        const tripleRead = String.raw`cat /Users/example/skills/happy-visual-workflow/SKILL.md
cat /Volumes/ZHITAI\ TiPlus7100s/Development/project/.agents/skills/dev/SKILL.md
cat /Users/example/skills/android-ops/SKILL.md`;
        const messages = [
            tool(1, 'Agent', { sessionSubagent: 'release-agent', description: 'Release verification' }),
            tool(2, 'Agent', { sessionSubagent: 'regression-agent', description: 'Regression verification' }),
            tool(3, 'Skill', { skill: 'ego-browser' }),
            tool(4, 'CodexBash', { command: ['/bin/zsh', '-lc', mixed] }),
            tool(5, 'CodexBash', { command: ['/bin/zsh', '-lc', tripleRead] }),
        ];
        const onToggle = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<AgentWorkGroupView
                group={{ type: 'agent-work-group', id: 'worked-group', messages,
                    hasRunning: false, hasPendingPermission: false, startedAt: 0, completedAt: 120_000 }}
                metadata={null} sessionId="session-one" expanded={false} onToggle={onToggle}
            />);
        });

        const texts = renderer.root.findAllByType('Text').map((node: any) => node.children.join(''));
        expect(texts.some((text: string) => text.startsWith('Worked '))).toBe(true);
        expect(renderer.root.find((node: any) => node.type === 'Pressable'
            && node.props.testID === 'conversation-agent-work-toggle').props.accessibilityState)
            .toEqual({ expanded: false });
        expect(texts).toContain('release-ops, confirmation-ops');
        expect(texts).toContain('happy-visual-workflow, dev, android-ops');
        expect(texts).toContain('ego-browser');
        expect(texts).toContain('Release verification');
        expect(texts).toContain('Regression verification');
        expect(texts.filter((text: string) => text === 'toolGroup.skillCommandStatus.completed')).toHaveLength(2);
        expect(texts.filter((text: string) => text === 'toolGroup.subagents.count')).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'activity-subagent-release-agent' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'activity-subagent-regression-agent' })).toHaveLength(1);
        expect(onToggle).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });
});
