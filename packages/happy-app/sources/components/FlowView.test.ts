import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => (typeof factory === 'function' ? factory({
            colors: {
                text: '#000',
                textSecondary: '#666',
                surfaceHigh: '#eee',
            },
        }) : factory),
    },
}));

import { FlowView } from './FlowView';

function makeFlow(overrides: Record<string, unknown> = {}) {
    return {
        runId: 'run-1',
        flowName: 'deploy-pipeline',
        startedAt: '2026-04-03T10:00:00Z',
        updatedAt: '2026-04-03T10:01:00Z',
        status: 'running',
        input: {},
        outputs: {},
        results: {},
        steps: [],
        sessionBindings: {},
        ...overrides,
    };
}

function makeStep(overrides: Record<string, unknown> = {}) {
    return {
        attemptId: 'attempt-1',
        nodeId: 'build',
        nodeType: 'acp',
        outcome: 'ok',
        startedAt: '2026-04-03T10:00:00Z',
        finishedAt: '2026-04-03T10:00:30Z',
        promptText: null,
        rawText: null,
        output: null,
        session: null,
        agent: null,
        ...overrides,
    };
}

function renderToText(element: React.ReactElement): string {
    let renderer: any;
    act(() => { renderer = create(element); });
    return JSON.stringify(renderer.toJSON());
}

describe('FlowView', () => {
    it('returns null for null/undefined flow', () => {
        let renderer: any;
        act(() => { renderer = create(React.createElement(FlowView, { flow: null })); });
        expect(renderer.toJSON()).toBeNull();

        act(() => { renderer = create(React.createElement(FlowView, { flow: undefined })); });
        expect(renderer.toJSON()).toBeNull();
    });

    it('returns null for non-FlowRunState objects', () => {
        let renderer: any;
        act(() => { renderer = create(React.createElement(FlowView, { flow: { foo: 'bar' } })); });
        expect(renderer.toJSON()).toBeNull();
    });

    it('renders an active running flow with current node', () => {
        const flow = makeFlow({
            currentNode: 'build-step',
            statusDetail: 'compiling',
            steps: [
                makeStep({ nodeId: 'init', outcome: 'ok' }),
            ],
        });

        const text = renderToText(React.createElement(FlowView, { flow }));

        expect(text).toContain('deploy-pipeline');
        expect(text).toContain('Running');
        expect(text).toContain('build-step');
        expect(text).toContain('compiling');
        expect(text).toContain('Steps (');
        expect(text).toContain('init');
        expect(text).toContain('elapsed');
    });

    it('renders a completed flow', () => {
        const flow = makeFlow({
            status: 'completed',
            finishedAt: '2026-04-03T10:02:00Z',
            steps: [
                makeStep({ attemptId: 'a1', nodeId: 'init', outcome: 'ok' }),
                makeStep({ attemptId: 'a2', nodeId: 'build', outcome: 'ok', finishedAt: '2026-04-03T10:01:30Z' }),
            ],
        });

        const text = renderToText(React.createElement(FlowView, { flow }));

        expect(text).toContain('deploy-pipeline');
        expect(text).toContain('Completed');
        expect(text).toContain('Steps (');
        expect(text).toContain('"2"');
        expect(text).toContain('total');
        // Should NOT show "current node" for terminal flows
        expect(text).not.toContain('Current:');
    });

    it('renders a failed flow with error', () => {
        const flow = makeFlow({
            status: 'failed',
            finishedAt: '2026-04-03T10:01:00Z',
            error: 'Build step timed out',
            steps: [
                makeStep({ attemptId: 'a1', nodeId: 'init', outcome: 'ok' }),
                makeStep({ attemptId: 'a2', nodeId: 'build', outcome: 'failed', error: 'timeout after 60s' }),
            ],
        });

        const text = renderToText(React.createElement(FlowView, { flow }));

        expect(text).toContain('Failed');
        expect(text).toContain('Build step timed out');
        expect(text).toContain('timeout after 60s');
    });

    it('renders a waiting flow with waitingOn', () => {
        const flow = makeFlow({
            status: 'waiting',
            waitingOn: 'user-approval',
        });

        const text = renderToText(React.createElement(FlowView, { flow }));

        expect(text).toContain('Waiting');
        expect(text).toContain('user-approval');
    });

    it('uses runTitle over flowName when available', () => {
        const flow = makeFlow({
            runTitle: 'Deploy v2.5',
        });

        const text = renderToText(React.createElement(FlowView, { flow }));

        expect(text).toContain('Deploy v2.5');
        expect(text).not.toContain('deploy-pipeline');
    });

    it('renders step outcomes with correct symbols', () => {
        const flow = makeFlow({
            status: 'failed',
            finishedAt: '2026-04-03T10:02:00Z',
            steps: [
                makeStep({ attemptId: 'a1', nodeId: 'init', outcome: 'ok' }),
                makeStep({ attemptId: 'a2', nodeId: 'build', outcome: 'failed' }),
                makeStep({ attemptId: 'a3', nodeId: 'cleanup', outcome: 'cancelled' }),
                makeStep({ attemptId: 'a4', nodeId: 'retry', outcome: 'timed_out' }),
            ],
        });

        const text = renderToText(React.createElement(FlowView, { flow }));

        // Check all outcome symbols are present
        expect(text).toContain('\u2713');  // ok checkmark
        expect(text).toContain('\u2717');  // failed X
        expect(text).toContain('\u2014');  // cancelled dash
        expect(text).toContain('\u23F1');  // timed_out timer
    });
});
