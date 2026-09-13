import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@/sync/typesMessage';

const settings = vi.hoisted(() => ({ compact: false, platform: 'ios', width: 390 }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), ScrollView: host('ScrollView'), Pressable: host('Pressable'),
        TouchableOpacity: host('TouchableOpacity'), ActivityIndicator: host('ActivityIndicator'),
        Platform: { get OS() { return settings.platform; }, select: (value: any) => value[settings.platform] ?? value.default },
        StyleSheet: { create: (styles: any) => styles }, useWindowDimensions: () => ({ width: settings.width }),
    };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme } = await import('@/theme');
    return {
        StyleSheet: { create: (styles: any) => typeof styles === 'function' ? styles(lightTheme) : styles },
        useUnistyles: () => ({ theme: lightTheme }),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null, Octicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/sync/storage', () => ({ useSetting: () => settings.compact, useLocalSetting: () => false }));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 0 }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('../layout', () => ({ layout: { maxWidth: 1200 } }));
vi.mock('../CodeView', async () => {
    const React = await import('react');
    return { CodeView: (props: any) => React.createElement('CodeView', props) };
});
vi.mock('../CommandView', async () => {
    const React = await import('react');
    return { CommandView: (props: any) => React.createElement('CommandView', props) };
});
vi.mock('./ToolSectionView', async () => {
    const React = await import('react');
    return { ToolSectionView: (props: any) => React.createElement('Section', props, props.children) };
});
vi.mock('./PermissionFooter', async () => {
    const React = await import('react');
    return { PermissionFooter: (props: any) => React.createElement('PermissionFooter', props) };
});
vi.mock('./ToolError', async () => {
    const React = await import('react');
    return { ToolError: (props: any) => React.createElement('ToolError', props) };
});
vi.mock('./ToolDiffView', async () => {
    const React = await import('react');
    return { ToolDiffView: (props: any) => React.createElement('DiffView', props) };
});
vi.mock('@/components/diff/DiffFileHeader', async () => {
    const React = await import('react');
    return { DiffFileHeader: (props: any) => React.createElement('DiffFileHeader', props, props.right) };
});
vi.mock('@/components/diff/DiffPalette', () => ({ useDiffPalette: () => ({ hunkBg: 'header', textSecondary: 'gray' }) }));
vi.mock('./views/_all', async () => {
    const React = await import('react');
    const { isTerminalToolName } = await import('@/utils/toolDisplay');
    const { BashViewFull } = await import('./views/BashViewFull');
    const { CodexPatchViewFull } = await import('./views/CodexPatchView');
    return {
        getToolViewComponent: (name: string) => ['apply_patch', 'CodexPatch', 'request_user_input', 'file'].includes(name)
            ? () => React.createElement('SpecializedView', { name }) : null,
        getToolFullViewComponent: (name: string) => isTerminalToolName(name) ? BashViewFull
            : name === 'apply_patch' ? CodexPatchViewFull : null,
    };
});

import { ToolView } from './ToolView';
import { ToolFullView } from './ToolFullView';
import { ToolHeader } from './ToolHeader';
import { CodexPatchView } from './views/CodexPatchView';
import { TaskView } from './views/TaskView';
import { EditView } from './views/EditView';
import { EditViewFull } from './views/EditViewFull';
import { WriteView } from './views/WriteView';
import { MultiEditView } from './views/MultiEditView';
import { MultiEditViewFull } from './views/MultiEditViewFull';
import { GeminiEditView } from './views/GeminiEditView';

const renderers: ReturnType<typeof create>[] = [];
function render(element: React.ReactElement) {
    let result: ReturnType<typeof create>;
    act(() => { result = create(element); });
    renderers.push(result!);
    return result!;
}
function tool(name: string, input: unknown = {}): ToolCall {
    return { name, input, description: null, state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2 };
}
beforeAll(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('__DEV__', false);
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterEach(() => {
    act(() => renderers.splice(0).forEach(renderer => renderer.unmount()));
    settings.compact = false;
    settings.platform = 'ios';
    settings.width = 390;
});

describe('tool rendering on mobile and web', () => {
    it.each([
        ['Edit', EditView, { old_string: '  x', new_string: '    x' }],
        ['Edit', EditViewFull, { old_string: '  x', new_string: '    x' }],
        ['MultiEdit', MultiEditView, { edits: [{ old_string: '  x', new_string: '    x' }] }],
        ['MultiEdit', MultiEditViewFull, { edits: [{ old_string: '  x', new_string: '    x' }] }],
        ['edit', GeminiEditView, { oldText: '  x', newText: '    x' }],
    ])('preserves whitespace-only edits in %s', (name, Component, input) => {
        const tree = render(React.createElement(Component as React.ComponentType<any>, {
            tool: tool(name as string, { ...(input as object), file_path: 'x.ts' }), metadata: null, messages: [],
        }));
        expect(tree.root.findByType('DiffView').props).toMatchObject({ oldText: '  x', newText: '    x' });
    });

    it.each([
        ['Edit', EditView, { old_string: 'const x = 1;', new_string: 'const x = 2;' }],
        ['Edit', EditViewFull, { old_string: 'const x = 1;', new_string: 'const x = 2;' }],
        ['Write', WriteView, { content: 'const x = 1;' }],
        ['MultiEdit', MultiEditView, { edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] }],
        ['MultiEdit', MultiEditViewFull, { edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] }],
        ['edit', GeminiEditView, { oldText: 'const x = 1;', newText: 'const x = 2;' }],
    ])('passes the real filename to syntax detection for %s', (name, Component, input) => {
        const tree = render(React.createElement(Component as React.ComponentType<any>, {
            tool: tool(name as string, { ...(input as object), file_path: '/repo/component.tsx' }),
            metadata: null, messages: [],
        }));
        expect(tree.root.findByType('DiffView').props.fileName).toBe('/repo/component.tsx');
    });

    it.each(['ios', 'android', 'web'])('shows commands and generic activities without raw chat JSON on %s', platform => {
        settings.platform = platform;
        const command = render(React.createElement(ToolView, {
            tool: { ...tool('CodexBash', { command: 'git status' }), description: 'Running CodexBash' }, metadata: null,
        }));
        expect(JSON.stringify(command.toJSON())).toContain('git status');
        expect(JSON.stringify(command.toJSON())).not.toContain('Running CodexBash');
        for (const name of ['write_stdin', 'kill_session', 'BashOutput', 'BashInput', 'BashStop', 'send_command_input', 'get_command_or_subagent_output', 'kill_command_or_subagent', 'create_agent', 'read_user_input', 'cancel_ask', 'future_tool']) {
            const row = render(React.createElement(ToolView, { tool: tool(name), metadata: null, sessionId: 's1', messageId: 'm1' }));
            expect(row.root.findAllByType('CodeView')).toHaveLength(0);
            expect(row.root.findAllByType('TouchableOpacity')).toHaveLength(1);
        }
    });

    it('preserves pending approval inputs and permission controls', () => {
        settings.compact = true;
        const pending = { ...tool('unknown', { path: '/sensitive' }), permission: { id: 'p1', status: 'pending' as const } };
        const row = render(React.createElement(ToolView, { tool: pending, metadata: null, sessionId: 's1' }));
        expect(row.root.findAllByType('CodeView')).toHaveLength(1);
        expect(row.root.findAllByType('PermissionFooter')).toHaveLength(1);
    });

    it('keeps patch diffs expanded and questions/attachments inline even in compact mode', () => {
        const patch = render(React.createElement(ToolView, { tool: tool('apply_patch'), metadata: null }));
        expect(patch.root.findAllByType('SpecializedView')).toHaveLength(1);
        settings.compact = true;
        for (const name of ['request_user_input', 'file']) {
            const row = render(React.createElement(ToolView, { tool: tool(name), metadata: null }));
            expect(row.root.findAllByType('SpecializedView')).toHaveLength(1);
        }
    });

    it('uses the wire title in the detail header', () => {
        const header = render(React.createElement(ToolHeader, { tool: { ...tool('future_tool'), title: 'Check release' } }));
        expect(JSON.stringify(header.toJSON())).toContain('Check release');
        expect(JSON.stringify(header.toJSON())).not.toContain('future_tool');
    });

    it('uses a single bounded title for loading and loaded tool details', () => {
        const loading = render(React.createElement(ToolHeader));
        expect(loading.root.findAllByType('Text')).toHaveLength(1);
        expect(loading.root.findByType('Text').props.numberOfLines).toBe(1);
        const patch = render(React.createElement(ToolHeader, {
            tool: tool('apply_patch', { patch: '*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n-old\n+new\n*** End Patch' }),
        }));
        expect(patch.root.findAllByType('Text')).toHaveLength(1);
        expect(patch.root.findByType('Text').props.ellipsizeMode).toBe('middle');
    });

    it('resolves file titles relative to the session and preserves explicit provider titles', () => {
        const metadata = { path: '/repo', host: 'machine' };
        const relative = render(React.createElement(ToolHeader, { tool: tool('Edit', { file_path: '/repo/src/a.ts' }), metadata }));
        expect(relative.root.findByType('Text').children.join('')).toBe('src/a.ts');
        const named = render(React.createElement(ToolHeader, {
            tool: { ...tool('Edit', { file_path: '/repo/src/a.ts' }), title: 'Update component' }, metadata,
        }));
        expect(named.root.findByType('Text').children.join('')).toBe('Update component');
    });

    it('uses the same readable labels for tools inside a task', () => {
        const children = [
            { ...tool('CodexBash', { command: 'git status' }), description: 'Running CodexBash' },
            tool('write_stdin', { session_id: 1 }),
            tool('tool_search'),
        ];
        const task = render(React.createElement(TaskView, {
            tool: tool('Task'), metadata: null,
            messages: children.map((tool, i) => ({ kind: 'tool-call' as const, id: `m${i}`, createdAt: 1, localId: null, tool, children: [] })),
        }));
        const output = JSON.stringify(task.toJSON());
        expect(output).toContain('git status');
        expect(output).toContain('Waiting for shell output (1)');
        expect(output).not.toContain('Running CodexBash');
        expect(output).not.toContain('write_stdin');
        expect(output).not.toContain('tool_search');
    });

    it.each(['Bash', 'CodexBash', 'exec_command', 'run_terminal_command', 'write_stdin', 'BashOutput'])('keeps %s output visible on the detail screen', name => {
        const full = render(React.createElement(ToolFullView, { tool: { ...tool(name, { command: 'echo hello' }), result: 'hello' } }));
        expect(full.root.findByType('CommandView').props.stdout).toBe('hello');
        expect(full.root.findByType('CommandView').props.syntaxHighlighting).toBe(true);
    });

    it('renders shell input distinctly from its output and keeps failures visible', () => {
        const full = render(React.createElement(ToolFullView, {
            tool: { ...tool('write_stdin', { session_id: 1, chars: 'yes\n' }), state: 'error', result: 'process exited' },
        }));
        expect(full.root.findByType('CommandView').props).toMatchObject({
            command: 'Sending input to shell (1)', prompt: '', error: 'process exited', commandLanguage: null,
        });
        expect(full.root.findByType('CodeView').props.code).toBe('yes\n');
    });

    it.each([390, 1024, 1600])('centers generic/terminal detail at width %s, retaining wide diffs', width => {
        settings.width = width;
        for (const name of ['read_file', 'future_tool', 'Bash', 'apply_patch']) {
            const full = render(React.createElement(ToolFullView, { tool: tool(name, { command: 'echo hello' }) }));
            const wrappers = full.root.findAllByType('View').map((node: any) => Object.assign({}, ...[node.props.style].flat().filter(Boolean)));
            const content = wrappers.find((style: any) => style.alignSelf === 'center' && style.width === '100%');
            expect(content).toMatchObject({
                maxWidth: name === 'apply_patch' ? 1200 : 800,
                paddingHorizontal: name === 'apply_patch' && width <= 700 ? 0 : 16,
            });
            // No nested horizontal scroller or terminal-only vertical offset.
            expect(full.root.findAllByType('ScrollView')).toHaveLength(1);
            expect(full.root.findByType('ScrollView').props.contentContainerStyle).toMatchObject({ paddingTop: 12, paddingBottom: 32 });
        }
    });

    it('renders raw apply_patch as a diff and retains execution failures', () => {
        const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch';
        const call = { ...tool('apply_patch', { patch }), state: 'error' as const, result: 'Context did not match' };
        const inline = render(React.createElement(CodexPatchView, { tool: call, metadata: null }));
        expect(inline.root.findByType('DiffView').props).toMatchObject({ oldText: 'old', newText: 'new' });
        expect(inline.root.findByType('DiffFileHeader').props.file).toMatchObject({ path: 'a.ts', kind: 'modified', additions: 1, deletions: 1 });
        expect(inline.root.findByType('ToolError').props.message).toBe('Context did not match');
        const full = render(React.createElement(ToolFullView, { tool: call }));
        expect(full.root.findByType('ToolError').props.message).toBe('Context did not match');
        expect(full.root.findByType('DiffFileHeader').props.file).toEqual(inline.root.findByType('DiffFileHeader').props.file);
    });

    it('falls back to unescaped patch text without losing permission controls on a malformed patch', () => {
        const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new';
        const row = render(React.createElement(CodexPatchView, {
            tool: tool('apply_patch', { patch }), metadata: null,
            permissionFooter: React.createElement('PermissionFooter'),
        }));
        expect(row.root.findByType('CodeView').props.code).toBe(patch);
        expect(row.root.findAllByType('PermissionFooter')).toHaveLength(1);
    });
});