import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ command: '', state: {} as any }));
vi.mock('node:child_process', () => ({ execFile: (_file: string, _args: string[], _options: unknown, callback: Function) => callback(null, { stdout: mocks.command, stderr: '' }) }));
vi.mock('@/codex/codexAccountLaunchState', () => ({ readCodexAccountLaunchState: async () => mocks.state }));
import { stopDetachedCodexWorker } from './stopDetachedCodexWorker';
const options = { pid: 987650, sessionId: 'session', machineId: 'machine', profileId: 'profile', homesRoot: '/private/homes' };
describe('detached worker replacement boundary', () => {
    beforeEach(() => {
        mocks.command = 'node /app/dist/codexWorkerEntry.mjs codex --resume thread CODEX_HOME=/private/homes/happy-codex-home-test';
        mocks.state = { machineId: 'machine', sourceSessionId: 'session', profileId: 'profile', identityInvalid: false };
    });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
    it('waits for the verified original worker to exit', async () => {
        let stopped = false;
        const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
            if (signal === 'SIGTERM') { stopped = true; return true; }
            if (stopped) throw Object.assign(new Error(), { code: 'ESRCH' });
            return true;
        });
        await stopDetachedCodexWorker(options);
        expect(kill).toHaveBeenCalledWith(options.pid, 'SIGTERM');
    });
    it('accepts an already exited process without signaling', async () => {
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
        await stopDetachedCodexWorker(options);
        expect(kill).toHaveBeenCalledTimes(1);
    });
    it.each(['session', 'profile', 'command', 'home'])('refuses a mismatched %s before signaling', async mismatch => {
        const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
        if (mismatch === 'session') mocks.state.sourceSessionId = 'another';
        if (mismatch === 'profile') mocks.state.profileId = 'another';
        if (mismatch === 'command') mocks.command = 'node /app/unrelated.mjs CODEX_HOME=/private/homes/happy-codex-home-test';
        if (mismatch === 'home') mocks.command = mocks.command.replace('/private/homes/', '/other/homes/');
        await expect(stopDetachedCodexWorker(options)).rejects.toThrow();
        expect(kill).not.toHaveBeenCalledWith(options.pid, 'SIGTERM');
    });
    it('blocks replacement when the verified worker never exits', async () => {
        vi.useFakeTimers(); vi.spyOn(process, 'kill').mockReturnValue(true);
        const pending = expect(stopDetachedCodexWorker(options)).rejects.toThrow('did not stop cleanly');
        await vi.advanceTimersByTimeAsync(5100); await pending;
    });
});
