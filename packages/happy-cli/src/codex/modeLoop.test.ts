import { describe, expect, it } from 'vitest';

import { codexModeLoop, resolveCodexStartingMode } from './modeLoop';

describe('resolveCodexStartingMode', () => {
    it('defaults terminal-started Codex sessions to local mode', () => {
        expect(resolveCodexStartingMode({ startedBy: 'terminal' })).toBe('local');
        expect(resolveCodexStartingMode({})).toBe('local');
    });

    it('honors explicit remote mode for terminal-started Codex sessions', () => {
        expect(resolveCodexStartingMode({
            startedBy: 'terminal',
            requestedMode: 'remote',
        })).toBe('remote');
    });

    it('forces daemon-started Codex sessions to remote mode', () => {
        expect(resolveCodexStartingMode({
            startedBy: 'daemon',
            requestedMode: 'local',
        })).toBe('remote');
    });
});

describe('codexModeLoop', () => {
    it('starts in local mode by default and exits with the local exit code', async () => {
        const visitedModes: string[] = [];

        const result = await codexModeLoop({
            startedBy: 'terminal',
            onModeChange: (mode) => visitedModes.push(mode),
            local: async () => ({ type: 'exit', code: 7 }),
            remote: async () => 'exit',
        });

        expect(result).toBe(7);
        expect(visitedModes).toEqual(['local']);
    });

    it('starts in remote mode when requested', async () => {
        const visitedModes: string[] = [];

        const result = await codexModeLoop({
            startedBy: 'terminal',
            requestedMode: 'remote',
            onModeChange: (mode) => visitedModes.push(mode),
            local: async () => ({ type: 'exit', code: 0 }),
            remote: async () => 'exit',
        });

        expect(result).toBe(0);
        expect(visitedModes).toEqual(['remote']);
    });

    it('switches from local to remote when the local launcher requests handoff', async () => {
        const visitedModes: string[] = [];

        const result = await codexModeLoop({
            startedBy: 'terminal',
            onModeChange: (mode) => visitedModes.push(mode),
            local: async () => ({ type: 'switch' }),
            remote: async () => 'exit',
        });

        expect(result).toBe(0);
        expect(visitedModes).toEqual(['local', 'remote']);
    });

    it('switches from remote back to local on explicit remote switch', async () => {
        const visitedModes: string[] = [];
        let localRuns = 0;

        const result = await codexModeLoop({
            startedBy: 'terminal',
            requestedMode: 'remote',
            onModeChange: (mode) => visitedModes.push(mode),
            local: async () => {
                localRuns++;
                return { type: 'exit', code: 0 };
            },
            remote: async () => 'switch',
        });

        expect(result).toBe(0);
        expect(localRuns).toBe(1);
        expect(visitedModes).toEqual(['remote', 'local']);
    });
});
