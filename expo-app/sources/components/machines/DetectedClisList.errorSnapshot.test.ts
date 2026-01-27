import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { select: (options: any) => options.default ?? options.ios ?? null },
    Text: 'Text',
    View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'experiments') return false;
        if (key === 'experimentalAgents') return {};
        return false;
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#666', status: { connected: '#0a0' } } } }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('DetectedClisList', () => {
    it('renders the last known snapshot when refresh fails', async () => {
        const { DetectedClisList } = await import('./DetectedClisList');

        const state: any = {
            status: 'error',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.codex': { ok: true, checkedAt: 1, data: { available: true, version: '1.2.3', resolvedPath: '/usr/bin/codex' } },
                        'tool.tmux': { ok: true, checkedAt: 1, data: { available: false } },
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(DetectedClisList, { state }));
        });
        const items = tree!.root.findAllByType('Item' as any);
        const titles = items.map((n: any) => n.props.title);

        expect(titles).toEqual(expect.arrayContaining(['agentInput.agent.claude', 'agentInput.agent.codex', 'tmux']));
        expect(titles).not.toContain('machine.detectedCliUnknown');
    });
});
