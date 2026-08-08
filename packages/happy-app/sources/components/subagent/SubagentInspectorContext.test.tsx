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
});
