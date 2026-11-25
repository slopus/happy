import * as React from 'react';
import { act } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    SubagentInspectorContextValue,
    SubagentInspectorProvider,
    useSubagentInspector,
} from './SubagentInspectorContext';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/update/unmount surface below.
import TestRenderer from 'react-test-renderer';

describe('SubagentInspectorProvider', () => {
    beforeAll(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('opens, replaces, closes, and clears selection when the session changes', () => {
        let inspector!: SubagentInspectorContextValue;

        function Probe() {
            const value = useSubagentInspector();
            if (!value) throw new Error('Subagent inspector provider is missing');
            inspector = value;
            return null;
        }

        const renderProvider = (sessionId: string) => (
            <SubagentInspectorProvider sessionId={sessionId}>
                <Probe />
            </SubagentInspectorProvider>
        );

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(renderProvider('session-one'));
        });
        expect(inspector.selection).toBeNull();

        act(() => inspector.open({
            id: 'agent-one',
            title: 'Implementation agent',
            status: 'running',
        }));
        expect(inspector.selection).toEqual({
            id: 'agent-one',
            title: 'Implementation agent',
            status: 'running',
        });

        act(() => inspector.open({
            id: 'agent-two',
            title: null,
            status: 'completed',
        }));
        expect(inspector.selection?.id).toBe('agent-two');

        act(() => inspector.close());
        expect(inspector.selection).toBeNull();

        act(() => inspector.open({
            id: 'agent-three',
            title: 'Reviewer',
            status: 'failed',
        }));
        act(() => renderer.update(renderProvider('session-two')));
        expect(inspector.selection).toBeNull();

        act(() => renderer.unmount());
    });

    it('keeps unsaved role edits and selected result versions across panel closes but scopes them to the session', () => {
        let inspector!: SubagentInspectorContextValue;
        function Probe() { inspector = useSubagentInspector()!; return null; }
        const render = (sessionId: string) => <SubagentInspectorProvider sessionId={sessionId}><Probe /></SubagentInspectorProvider>;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(render('parent-a')); });
        const draft = { id: 'role-a', name: 'Unsaved role', description: 'Keep my edited purpose', agent: 'antigravity' as const, model: 'exact-code', autoDelegate: true };
        inspector.roleDrafts!.current.set('role-a', draft);
        inspector.taskViews!.current.set('task-a', { tab: 'result', version: 2 });
        act(() => inspector.open({ kind: 'agent-roles', id: 'agent-roles', title: 'Assistants', status: 'completed' }));
        act(() => inspector.close());
        expect(inspector.roleDrafts!.current.get('role-a')).toEqual(draft);
        expect(inspector.taskViews!.current.get('task-a')).toEqual({ tab: 'result', version: 2 });
        act(() => renderer.update(render('parent-b')));
        expect(inspector.roleDrafts!.current.size).toBe(0);
        expect(inspector.taskViews!.current.size).toBe(0);
        act(() => renderer.unmount());
    });
});
