import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SpawnOptions, ChildProcessWithoutNullStreams } from 'node:child_process';

type SpawnCall = {
    command: string;
    args: string[];
    options: SpawnOptions;
};

const { spawnMock, getLastSpawnCall } = vi.hoisted(() => {
    let lastSpawnCall: SpawnCall | null = null;

    const spawnMock = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
        lastSpawnCall = { command, args: [...args], options };

        type MinimalChild = EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
        };

        const child = new EventEmitter() as MinimalChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();

        queueMicrotask(() => {
            child.emit('close', 0);
        });

        return child as unknown as ChildProcessWithoutNullStreams;
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
        const { TmuxUtilities } = await import('@/integrations/tmux');

        const socketPath = '/tmp/happy-cli-tmux-test.sock';
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        await utils.executeTmuxCommand(['list-sessions']);

        const call = getLastSpawnCall();
        expect(call).not.toBeNull();
        expect(call!.command).toBe('tmux');
        expect(call!.args).toEqual(expect.arrayContaining(['-S', socketPath]));
    });
});
