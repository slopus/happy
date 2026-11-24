import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error renderer declarations are not installed.
import TestRenderer from 'react-test-renderer';
import { ToolFullView } from './ToolFullView.web';
import { TranscriptReadOnlyContext } from '../TranscriptReadOnlyContext';
import type { ToolCall } from '@/sync/typesMessage';

const fixture = vi.hoisted(() => ({ dev: false, specialized: null as any }));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
    Platform: { select: (values: Record<string, unknown>) => values.default ?? values.android }, StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => fixture.dev }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('../CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('./PermissionFooter', () => ({ PermissionFooter: 'PermissionFooter' }));
vi.mock('./views/_all', () => ({ getToolFullViewComponent: () => fixture.specialized }));
vi.mock('react-native-unistyles', () => {
    const colors: any = new Proxy({}, { get: (_target, key) => String(key) });
    return { StyleSheet: { create: (factory: any) => factory({ colors }), hairlineWidth: 1 }, useUnistyles: () => ({ theme: { colors } }) };
});

const base: ToolCall = { name: 'execute', state: 'completed', input: { CommandLine: 'ls -la /example', WaitMsBeforeAsync: 5000, toolSummary: 'Inspect the example directory' },
    description: 'Running execute', createdAt: 1, startedAt: 1, completedAt: 2, permission: { id: 'request', status: 'pending' } };
let renderer: any;
let errorSpy: ReturnType<typeof vi.spyOn>;
const render = (tool: ToolCall = base, props = {}) => {
    act(() => { renderer = TestRenderer.create(<ToolFullView tool={tool} sessionId="original" {...props} />); });
};
const codes = () => renderer.root.findAllByType('CodeView').map((node: any) => node.props.code);
const button = (testID: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === testID);
beforeEach(() => {
    (globalThis as any).__DEV__ = false;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    fixture.dev = false; fixture.specialized = null;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { act(() => renderer?.unmount()); errorSpy.mockRestore(); });

describe('web tool details', () => {
    it.each(['Bash', 'CodexBash', 'execute'])('renders %s stdout and stderr as actual multiline terminal text', name => {
        render({ ...base, name, result: { stdout: 'first\nsecond\n', stderr: 'warning one\nwarning two\n' } });
        const texts = renderer.root.findAllByType('Text').map((node: any) => node.props.children);
        expect(texts).toContain('first\nsecond\n');
        expect(texts).toContain('warning one\nwarning two\n');
        expect(codes()).toHaveLength(0);
    });

    it('keeps CodexBash plain-text output when its inline view would discard the result', () => {
        fixture.specialized = () => <TextProbe />;
        render({ ...base, name: 'CodexBash', result: 'first\nsecond\n' });
        expect(codes()).toContain('first\nsecond\n');
        expect(renderer.root.findAllByType(TextProbe)).toHaveLength(0);
    });

    it('shows a compact no-output state for empty terminal streams', () => {
        render({ ...base, result: { stdout: '', stderr: '' } });
        expect(JSON.stringify(renderer.toJSON())).toContain('tools.fullView.noOutput');
        expect(JSON.stringify(renderer.toJSON())).not.toContain('[Command completed with no output]');
    });

    it.each([undefined, 'Permission denied'])('keeps failure and cancellation reasons visible alongside a specialized edit view (result=%j)', result => {
        fixture.specialized = () => <TextProbe />;
        render({ ...base, name: 'Edit', input: {}, state: 'error', result, failure: { detail: 'Permission denied', summary: 'Edit failed' } });
        expect(renderer.root.findAllByType(TextProbe)).toHaveLength(1);
        expect(JSON.stringify(renderer.toJSON())).toContain('Permission denied');
        act(() => renderer.update(<ToolFullView tool={{ ...base, name: 'Edit', input: {}, state: 'cancelled', cancellationReason: 'User cancelled the edit' }} />));
        expect(renderer.root.findAllByType(TextProbe)).toHaveLength(1);
        expect(JSON.stringify(renderer.toJSON())).toContain('User cancelled the edit');
    });
    it('shows the actual command and summary, folds protocol parameters, and hides stale approvals on a completed tool', () => {
        render();
        expect(codes()).toEqual(['ls -la /example']);
        expect(JSON.stringify(renderer.toJSON())).toContain('Inspect the example directory');
        expect(JSON.stringify(renderer.toJSON())).not.toContain('Running execute');
        expect(renderer.root.findAllByType('PermissionFooter')).toHaveLength(0);
        act(() => button('tool-detail-input').props.onPress());
        expect(JSON.parse(codes()[1])).toEqual(base.input);
        act(() => button('tool-detail-input').props.onPress());
        expect(codes()).toEqual(['ls -la /example']);
    });

    it.each([0, false, 'terminal output'])('preserves meaningful falsy/string output: %j', result => {
        render({ ...base, result });
        expect(codes()).toContain(typeof result === 'string' ? result : JSON.stringify(result));
        expect(JSON.stringify(renderer.toJSON())).not.toContain('tools.fullView.noOutput');
    });

    it('keeps active approval controls reachable and suppresses them for continued history', () => {
        const tool: ToolCall = { ...base, state: 'running' };
        render(tool);
        expect(renderer.root.findByType('PermissionFooter').props.permission.id).toBe('request');
        expect(JSON.stringify(renderer.toJSON())).not.toContain('tools.fullView.noOutput');
        act(() => renderer.update(<ToolFullView tool={tool} sessionId="original" metadata={{ continuedBySessionId: 'next' } as any} />));
        expect(renderer.root.findAllByType('PermissionFooter')).toHaveLength(0);
    });

    it('honors read-only context for embedded details', () => {
        act(() => { renderer = TestRenderer.create(<TranscriptReadOnlyContext.Provider value={true}>
            <ToolFullView tool={{ ...base, state: 'running' }} sessionId="original" />
        </TranscriptReadOnlyContext.Provider>); });
        expect(renderer.root.findAllByType('PermissionFooter')).toHaveLength(0);
    });

    it('keeps developer JSON folded until requested', () => {
        fixture.dev = true;
        render();
        expect(codes()).toHaveLength(1);
        act(() => button('tool-detail-raw').props.onPress());
        expect(JSON.parse(codes()[1])).toMatchObject({ name: 'execute', state: 'completed', messages: [] });
    });

    it('renders recorded failures and cancellation reasons even without result output', () => {
        render({ ...base, state: 'error', failure: { summary: 'Execution failed', detail: 'Executable unavailable' } });
        expect(JSON.stringify(renderer.toJSON())).toContain('Executable unavailable');
        act(() => renderer.update(<ToolFullView tool={{ ...base, state: 'cancelled', cancellationReason: 'User stopped the command' }} />));
        expect(JSON.stringify(renderer.toJSON())).toContain('User stopped the command');
        expect(renderer.root.findAllByType('PermissionFooter')).toHaveLength(0);
    });

    it('preserves specialized views and propagates read-only protection', () => {
        fixture.specialized = ({ tool, sessionId }: any) => <TextProbe tool={tool} sessionId={sessionId} readOnly={React.useContext(TranscriptReadOnlyContext)} />;
        render({ ...base, name: 'Edit', input: {} }, { metadata: { continuedBySessionId: 'next' } });
        expect(renderer.root.findByType(TextProbe).props).toMatchObject({ sessionId: 'original', readOnly: true });
    });
});

function TextProbe(_props: any) { return null; }
