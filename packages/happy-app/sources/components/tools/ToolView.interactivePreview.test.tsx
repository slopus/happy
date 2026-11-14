import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ language: 'en' as 'en' | 'zh-Hans' }));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
}));
vi.mock('react-native-unistyles', () => {
    const theme: Record<string, any> = { colors: { surfaceHigh: '#111', surfaceHighest: '#222', text: '#fff', textSecondary: '#aaa', warning: '#f90' } };
    return { StyleSheet: { create: (factory: (value: typeof theme) => object) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/text', () => ({
    t: (key: string) => key === 'interactivePreviews.title'
        ? (mocks.language === 'en' ? 'Temporary previews' : '临时交互预览')
        : key,
}));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 1 }));
vi.mock('@/utils/toolDisplay', () => ({
    getTerminalToolCommand: (tool: any) => tool.name === 'CodexBash' ? tool.input?.command ?? null : null, isInlineAudioFileTool: () => false, isInlineImageFileTool: () => false, isInlineVideoFileTool: () => false, shouldRenderToolCardHeader: () => true,
}));
vi.mock('./views/_all', () => ({ getToolViewComponent: () => null }));
vi.mock('./views/MCPToolView', () => ({ formatMCPTitle: () => 'Demo App' }));
vi.mock('@/utils/toolErrorParser', () => ({ parseToolUseError: () => ({ isToolUseError: false }) }));
vi.mock('./PermissionFooter', () => ({ PermissionFooter: () => null }));
vi.mock('./ToolError', () => ({ ToolError: 'ToolError' }));
vi.mock('../CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('./ToolSectionView', () => ({ ToolSectionView: 'ToolSectionView' }));
vi.mock('./McpAppHost', () => ({ McpAppHost: 'McpAppHost' }));

import { ToolView } from './ToolView';

const tool = {
    callId: 'preview-call', name: 'interactive-preview', state: 'completed' as const,
    input: { id: '11111111-1111-4111-8111-111111111111', state: 'publishing' },
    createdAt: 1, startedAt: 1, completedAt: 2, description: null,
};

describe('ToolView interactive preview title', () => {
    it('keeps a mixed historical Skill failure visible as a terminal error', () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ToolView metadata={null} tool={{
            ...tool, name: 'Skill', state: 'error',
            input: { skillNames: ['release-ops'], command: 'cat /skills/release-ops/SKILL.md; ls /missing' },
            result: 'ls: /missing: No such file or directory',
        }} />); });
        expect(renderer.root.findByProps({ testID: 'tool-card-header' })).toBeTruthy();
        expect(renderer.root.findAllByType('Ionicons').some((node: any) => node.props.name === 'alert-circle-outline')).toBe(true);
        expect(renderer.root.findByType('ToolError').props.message).toBe('ls: /missing: No such file or directory');
        act(() => renderer.unmount());
    });

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it.each([
        ['en', 'Temporary previews'],
        ['zh-Hans', '临时交互预览'],
    ] as const)('renders the localized known-tool title in %s', (language, title) => {
        mocks.language = language;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ToolView metadata={null} tool={tool} />); });
        expect(renderer.root.findByProps({ testID: 'tool-card-header' }).findAllByType('Text').map((node: any) => node.children.join(''))).toContain(title);
        act(() => renderer.unmount());
    });
});

vi.mock('@/hooks/useDesktopFileWorkspaceAvailable', () => ({ useDesktopFileWorkspaceAvailable: () => false }));
