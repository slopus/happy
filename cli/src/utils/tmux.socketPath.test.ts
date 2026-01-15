import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';

const { spawnMock, getLastSpawnCall } = vi.hoisted(() => {
    let lastSpawnCall: { command: string; args: string[]; options: SpawnOptions } | null = null;

    const spawnMock = vi.fn((command: string, args: string[], options: SpawnOptions) => {
        lastSpawnCall = { command, args, options };

        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();

        queueMicrotask(() => {
            child.emit('close', 0);
        });

        return child;
    });

    return {
        spawnMock,
        getLastSpawnCall: () => lastSpawnCall,
    };
});

vi.mock('child_process', () => ({
    spawn: spawnMock,
}));

describe('TmuxUtilities tmux socket path', () => {
    beforeEach(() => {
        spawnMock.mockClear();
    });

    it('uses -S <socketPath> by default when configured', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('./tmux');

        const utils = new (TmuxUtilities as any)('happy', undefined, '/tmp/happy-cli-tmux-test.sock');
        await utils.executeTmuxCommand(['list-sessions']);

        const call = getLastSpawnCall();
        expect(call?.command).toBe('tmux');
        expect(call?.args).toEqual(expect.arrayContaining(['-S', '/tmp/happy-cli-tmux-test.sock']));
    });
});

