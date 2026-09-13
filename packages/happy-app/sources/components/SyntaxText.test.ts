import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyntaxService } from './diff/syntax/service';
import { MAX_SYNTAX_LINE, type SyntaxInput, type SyntaxResult } from './diff/syntax/protocol';
import { tokenize } from './diff/syntax/tokenize';

const state = vi.hoisted(() => ({ service: undefined as unknown as SyntaxService, dark: false }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        Text: host('Text'), View: host('View'),
        Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
        StyleSheet: { create: (styles: any) => styles },
    };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme, darkTheme } = await import('@/theme');
    return { useUnistyles: () => ({ theme: state.dark ? darkTheme : lightTheme }) };
});
vi.mock('./diff/syntax/shared', () => ({ get diffSyntax() { return state.service; } }));

import { SyntaxText } from './SyntaxText';
import { CommandView } from './CommandView';
import { darkTheme } from '@/theme';

const renderers: ReturnType<typeof create>[] = [];
const jobs: { input: SyntaxInput; resolve: (result: SyntaxResult) => void }[] = [];
const run = vi.fn((input: SyntaxInput) => new Promise<SyntaxResult>((resolve) => jobs.push({ input, resolve })));
function render(element: React.ReactElement) {
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(element); });
    renderers.push(renderer!);
    return renderer!;
}
function textOf(node: any): string {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    return node?.children ? textOf(node.children) : '';
}
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const finish = async (index: number) => { await act(async () => { jobs[index].resolve(tokenize(jobs[index].input)); }); };
const syntax = (tree: ReturnType<typeof create>) => tree.root.findAllByType('Text').filter((node: any) => node.props.testID?.startsWith('terminal-syntax-'));

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('__DEV__', false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
    run.mockClear();
    jobs.length = 0;
    state.dark = false;
    state.service = new SyntaxService({ run }, () => {});
});
afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('detail-only terminal syntax', () => {
    it('enqueues nothing for the default compact CommandView', async () => {
        const tree = render(React.createElement(CommandView, { command: 'echo "$USER"', stdout: '$ echo "hi"\nhi' }));
        await tick(1000);
        expect(run).not.toHaveBeenCalled();
        expect(syntax(tree)).toHaveLength(0);
        expect(textOf(tree.toJSON())).toContain('echo "$USER"');
    });

    it('reserves layout until first paint, then exposes selectable colored text without losing whitespace', async () => {
        const code = 'echo "🙂"  \r\n\n';
        const tree = render(React.createElement(SyntaxText, { code, language: 'bash' }));
        expect(syntax(tree)[0].props).toMatchObject({
            testID: 'terminal-syntax-pending', selectable: false,
            accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants',
        });
        expect(textOf(tree.toJSON())).toBe(code);
        await tick(20);
        await finish(0);
        expect(syntax(tree)[0].props).toMatchObject({ testID: 'terminal-syntax-ready', selectable: true, accessibilityElementsHidden: false });
        expect(tree.root.findAllByType('Text').length).toBeGreaterThan(1);
        expect(textOf(tree.toJSON())).toBe(code);
        expect(state.service.getStats()).toMatchObject({ completed: 1, running: false });
    });

    it.each([false, true])('uses readable dark-surface colors even when app dark mode is %s', async dark => {
        state.dark = dark;
        const tree = render(React.createElement(CommandView, {
            command: 'echo "hi"', stdout: 'if true 123\n', stderr: 'failed\n', syntaxHighlighting: true,
        }));
        await tick(1);
        expect(jobs[0].input.language).toBe('bash');
        await finish(0);
        await tick(1);
        expect(jobs[1].input.language).toBe('shell-session');
        await finish(1);
        await tick(1);
        await finish(2);
        const colored = tree.root.findAllByType('Text').filter((node: any) => node.props.style?.color === darkTheme.colors.diff.syntax.string);
        expect(colored).toHaveLength(1);
        expect(textOf(colored[0])).toBe('"hi"');
        // Logs retain stdout/stderr colors, not misleading Bash token colors.
        expect(syntax(tree).slice(1).every((node: any) => node.children.every((child: unknown) => typeof child === 'string'))).toBe(true);
    });

    it('reveals plain at one second, ignores late recoloring and reuses that result on the next visit', async () => {
        const props = { code: 'echo "hi"', language: 'bash' };
        const tree = render(React.createElement(SyntaxText, props));
        await tick(999);
        expect(syntax(tree)[0].props.testID).toBe('terminal-syntax-pending');
        await tick(1);
        expect(syntax(tree)[0].props.testID).toBe('terminal-syntax-ready');
        expect(tree.root.findAllByType('Text')).toHaveLength(1);
        await finish(0);
        expect(tree.root.findAllByType('Text')).toHaveLength(1);
        act(() => tree.unmount());
        const revisit = render(React.createElement(SyntaxText, props));
        expect(syntax(revisit)[0].props.testID).toBe('terminal-syntax-ready');
        expect(revisit.root.findAllByType('Text').length).toBeGreaterThan(1);
        expect(run).toHaveBeenCalledTimes(1);
        expect(state.service.getStats().hits).toBe(1);
    });

    it('does not extend the wait while streaming, blank shown text or apply stale results', async () => {
        const tree = render(React.createElement(SyntaxText, { code: 'echo old', language: 'bash' }));
        await tick(600);
        act(() => tree.update(React.createElement(SyntaxText, { code: 'echo new', language: 'bash' })));
        await finish(0);
        expect(syntax(tree)[0].props.testID).toBe('terminal-syntax-pending');
        await tick(400);
        expect(syntax(tree)[0].props.testID).toBe('terminal-syntax-ready');
        expect(textOf(tree.toJSON())).toBe('echo new');
        act(() => tree.update(React.createElement(SyntaxText, { code: 'echo newest', language: 'bash' })));
        expect(syntax(tree)[0].props.testID).toBe('terminal-syntax-ready');
        expect(textOf(tree.toJSON())).toBe('echo newest');
        await finish(1);
        expect(textOf(tree.toJSON())).toBe('echo newest');
    });

    it('does not tokenize activity labels or hide execution errors behind syntax work', async () => {
        const tree = render(React.createElement(CommandView, {
            command: 'Waiting for shell output', commandLanguage: null,
            stdout: '$ echo "hi"\nhi', error: 'Process failed', syntaxHighlighting: true,
        }));
        await tick(1);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].input.language).toBe('shell-session');
        expect(textOf(tree.toJSON())).toContain('Process failed');
        expect(syntax(tree)).toHaveLength(1);
    });

    it('keeps oversized output immediately readable without starting a worker', async () => {
        const code = 'x'.repeat(MAX_SYNTAX_LINE + 1);
        const tree = render(React.createElement(SyntaxText, { code, language: 'shell-session' }));
        expect(syntax(tree)[0].props.testID).toBe('terminal-syntax-ready');
        expect(textOf(tree.toJSON())).toBe(code);
        await tick(1000);
        expect(run).not.toHaveBeenCalled();
    });

    it('deduplicates mounted readers and cancels abandoned queued work', async () => {
        const first = render(React.createElement(SyntaxText, { code: 'echo "same"', language: 'bash' }));
        render(React.createElement(SyntaxText, { code: 'echo "same"', language: 'bash' }));
        const abandoned = render(React.createElement(SyntaxText, { code: 'echo "abandoned"', language: 'bash' }));
        await tick(1);
        expect(state.service.getStats()).toMatchObject({ running: true, queued: 1 });
        act(() => { first.unmount(); abandoned.unmount(); });
        expect(state.service.getStats()).toMatchObject({ queued: 0, cancelled: 2 });
        await finish(0);
        await tick(1);
        expect(run).toHaveBeenCalledTimes(1);
    });
});