import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { ProcessDescriptor } from 'ps-list';
import {
    isDaemonSpawnedSessionProcess,
    reapOrphanedDaemonSessions,
    terminateDaemonOwnedSessions,
    terminateDetachedProcessTree,
} from './sessionTermination';

function processInfo(overrides: Partial<ProcessDescriptor> = {}): ProcessDescriptor {
    return {
        pid: 123,
        ppid: 1,
        uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
        name: 'node',
        cmd: 'node /opt/happy/dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
        ...overrides,
    };
}

describe('daemon session termination', () => {
    it('only terminates sessions owned by the daemon', async () => {
        const terminateTree = vi.fn().mockResolvedValue(undefined);
        const result = await terminateDaemonOwnedSessions([
            { pid: 10, startedBy: 'daemon' },
            { pid: 11, startedBy: 'happy directly - likely by user from terminal' },
            { pid: 12, startedBy: 'persisted' },
        ], { terminateTree });

        expect(terminateTree).toHaveBeenCalledWith(10);
        expect(terminateTree).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ terminated: 1, errors: [] });
    });

    it('kills the complete Windows process tree', async () => {
        const runTaskkill = vi.fn().mockResolvedValue(undefined);
        await terminateDetachedProcessTree(42, { platform: 'win32', runTaskkill });
        expect(runTaskkill).toHaveBeenCalledWith(['/PID', '42', '/T']);
    });

    it('escalates a stubborn POSIX detached process group', async () => {
        const signals: Array<[number, NodeJS.Signals | 0]> = [];
        const killProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
            signals.push([pid, signal]);
        });

        await terminateDetachedProcessTree(42, { platform: 'darwin', graceMs: 0, killProcess });

        expect(signals).toContainEqual([42, 'SIGTERM']);
        expect(signals).toContainEqual([-42, 'SIGTERM']);
        expect(signals).toContainEqual([-42, 'SIGKILL']);
    });

    it('strictly identifies reparented daemon-spawned Happy sessions', () => {
        const entrypoint = '/opt/happy/dist/index.mjs';
        expect(isDaemonSpawnedSessionProcess(processInfo(), entrypoint)).toBe(true);
        expect(isDaemonSpawnedSessionProcess(processInfo({ ppid: 999 }), entrypoint)).toBe(true);
        expect(isDaemonSpawnedSessionProcess(processInfo({ cmd: 'node /opt/happy/dist/index.mjs claude --started-by terminal' }), entrypoint)).toBe(false);
        expect(isDaemonSpawnedSessionProcess(processInfo({ cmd: 'node /other/dist/index.mjs claude --started-by daemon' }), entrypoint)).toBe(false);
    });

    it('revalidates an orphan process before terminating it', async () => {
        const candidate = processInfo();
        const listProcesses = vi.fn()
            .mockResolvedValueOnce([candidate])
            .mockResolvedValueOnce([candidate]);
        const terminateTree = vi.fn().mockResolvedValue(undefined);

        await expect(reapOrphanedDaemonSessions({
            platform: 'darwin',
            listProcesses,
            terminateTree,
            expectedEntrypoint: '/opt/happy/dist/index.mjs',
        })).resolves.toEqual({ terminated: 1, errors: [] });
        expect(terminateTree).toHaveBeenCalledWith(candidate.pid);
    });

    it.skipIf(process.platform === 'win32')('reaps a real detached root and its descendant', { timeout: 5_000 }, async () => {
        const root = spawn(process.execPath, ['-e', `
            const { spawn } = require('node:child_process');
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
            console.log(child.pid);
            process.on('SIGTERM', () => process.exit(0));
            setInterval(() => {}, 1000);
        `], {
            detached: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const rootPid = root.pid!;
        const descendantPid = await new Promise<number>((resolve, reject) => {
            root.once('error', reject);
            root.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim())));
        });
        const rootExited = new Promise<void>((resolve) => root.once('exit', () => resolve()));

        try {
            await terminateDetachedProcessTree(rootPid, { graceMs: 500 });
            await rootExited;

            expect(() => process.kill(rootPid, 0)).toThrow();
            expect(() => process.kill(descendantPid, 0)).toThrow();
        } finally {
            try { process.kill(-rootPid, 'SIGKILL'); } catch { }
        }
    });
});
