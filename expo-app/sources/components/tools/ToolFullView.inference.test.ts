import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { type ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('../CodeView', () => ({
    CodeView: () => null,
}));

const renderedFullViewSpy = vi.fn();
const renderedViewSpy = vi.fn();

const getToolFullViewComponentSpy = vi.fn((toolName: string) => {
    if (toolName === 'execute') {
        return (props: any) => {
            renderedFullViewSpy(props);
            return React.createElement('FullToolView', { name: toolName });
        };
    }
    return null;
});

const getToolViewComponentSpy = vi.fn((toolName: string) => {
    if (toolName === 'Read') {
        return (props: any) => {
            renderedViewSpy(props);
            return React.createElement('ToolView', { name: toolName });
        };
    }
    return null;
});

vi.mock('./views/_registry', () => ({
    getToolFullViewComponent: getToolFullViewComponentSpy,
    getToolViewComponent: getToolViewComponentSpy,
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        execute: { title: 'Terminal' },
        Read: { title: 'Read' },
    },
}));

vi.mock('./views/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

describe('ToolFullView (inference + view selection)', () => {
    it('uses tool.input._acp.kind to select a full view component', async () => {
        renderedFullViewSpy.mockReset();
        renderedViewSpy.mockReset();
        getToolFullViewComponentSpy.mockClear();
        getToolViewComponentSpy.mockClear();
        const { ToolFullView } = await import('./ToolFullView');

        const tool: ToolCall = {
            name: 'Run echo hello',
            state: 'completed',
            input: { _acp: { kind: 'execute', title: 'Run echo hello' }, command: ['/bin/zsh', '-lc', 'echo hello'] },
            result: { stdout: 'hello\n', stderr: '' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: 'Run echo hello',
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolFullView, { tool, metadata: null, messages: [] }));
        });

        expect(tree.root.findAllByType('FullToolView' as any)).toHaveLength(1);
        expect(renderedFullViewSpy).toHaveBeenCalled();
        expect(getToolFullViewComponentSpy).toHaveBeenCalledWith('execute');
    });

    it('falls back to the normal tool view component when no full view component exists', async () => {
        renderedFullViewSpy.mockReset();
        renderedViewSpy.mockReset();
        getToolFullViewComponentSpy.mockClear();
        getToolViewComponentSpy.mockClear();
        const { ToolFullView } = await import('./ToolFullView');

        const tool: ToolCall = {
            name: 'Read',
            state: 'completed',
            input: { file_path: '/tmp/a.txt' },
            result: { content: 'hello' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolFullView, { tool, metadata: null, messages: [] }));
        });

        expect(tree.root.findAllByType('ToolView' as any)).toHaveLength(1);
        expect(renderedViewSpy).toHaveBeenCalled();
        expect(renderedFullViewSpy).not.toHaveBeenCalled();
        expect(getToolViewComponentSpy).toHaveBeenCalledWith('Read');
    });
});
