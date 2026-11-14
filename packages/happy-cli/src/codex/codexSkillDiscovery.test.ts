import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverCodexSkillNames } from './codexSkillDiscovery';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), debug: vi.fn() }));
vi.mock('../utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawn }));
vi.mock('../ui/logger', () => ({ logger: { debug: mocks.debug } }));

function childProcess() {
    return Object.assign(new EventEmitter(), {
        pid: 12345, exitCode: null as number | null,
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
        kill: vi.fn(() => true), unref: vi.fn(),
    });
}

describe('isolated startup Skill discovery', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
    afterEach(() => vi.useRealTimers());

    it('launches only the packaged scanner and accepts a complete valid result', async () => {
        const child = childProcess();
        mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
        const pending = discoverCodexSkillNames({ cwd: '/project', homeDir: '/synthetic-home' });
        expect(mocks.spawn).toHaveBeenCalledWith([JSON.stringify({ cwd: '/project', homeDir: '/synthetic-home' })], {
            entrypoint: 'codex-skill-discovery', stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.stdout.write('["workflow",');
        child.stdout.write('"plugin:docs"]');
        child.emit('close', 0);
        await expect(pending).resolves.toEqual(['workflow', 'plugin:docs']);
        expect(child.kill).not.toHaveBeenCalled();
        expect(child.unref).toHaveBeenCalledOnce();
        expect(child.stdout.destroyed).toBe(true);
        await vi.runAllTimersAsync();
        expect(child.kill).not.toHaveBeenCalled();
    });

    it('resolves at the deadline without waiting for a blocked child to close', async () => {
        const child = childProcess();
        mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
        const pending = discoverCodexSkillNames({ timeoutMs: 25 });
        await vi.advanceTimersByTimeAsync(25);
        await expect(pending).resolves.toEqual([]);
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
        expect(child.unref).toHaveBeenCalledOnce();
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stderr.destroyed).toBe(true);
        expect(child.stdin.destroyed).toBe(true);
        expect(child.listenerCount('close')).toBe(0);
        expect(child.stdout.listenerCount('data')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        // A late process event cannot change the result or trigger another kill.
        child.emit('error', new Error('late child error'));
        child.emit('close', 0);
        expect(child.kill).toHaveBeenCalledOnce();
    });

    it('terminates and reaps its actual isolated process while leaving the caller responsive', async () => {
        vi.useRealTimers();
        const child = spawn(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'], {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const closed = once(child, 'close');
        mocks.spawn.mockReturnValue(child);
        let callerRan = false;
        const callerTurn = new Promise<void>(resolve => setImmediate(() => { callerRan = true; resolve(); }));
        try {
            await expect(discoverCodexSkillNames({ timeoutMs: 50 })).resolves.toEqual([]);
            await callerTurn;
            expect(callerRan).toBe(true);
            expect(child.stdout?.destroyed).toBe(true);
            await expect(closed).resolves.toEqual([null, 'SIGKILL']);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
    });

    it.each(['not json', '{}', '[1]', '[""]', '[" valid "]'])('skips invalid scanner output: %s', async output => {
        const child = childProcess();
        mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
        const pending = discoverCodexSkillNames();
        child.stdout.write(output);
        child.emit('close', 0);
        await expect(pending).resolves.toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores apparently valid partial output from an unsuccessful child', async () => {
        const child = childProcess();
        mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
        const pending = discoverCodexSkillNames();
        child.stdout.write('["partial"]');
        child.emit('close', 1);
        await expect(pending).resolves.toEqual([]);
    });

    it('bounds scanner output and stops only its own child', async () => {
        const child = childProcess();
        mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
        const pending = discoverCodexSkillNames();
        child.stdout.write('x'.repeat(128 * 1024 + 1));
        await expect(pending).resolves.toEqual([]);
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
        expect(child.unref).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('continues startup when spawning the scanner throws', async () => {
        mocks.spawn.mockImplementationOnce(() => { throw new Error('missing entry'); });
        await expect(discoverCodexSkillNames()).resolves.toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('continues startup on an asynchronous spawn error without waiting for close', async () => {
        const child = childProcess();
        mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
        const pending = discoverCodexSkillNames();
        child.emit('error', new Error('spawn unavailable'));
        await expect(pending).resolves.toEqual([]);
        expect(child.unref).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
