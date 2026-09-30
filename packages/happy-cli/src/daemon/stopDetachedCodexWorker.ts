import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { readCodexAccountLaunchState } from '@/codex/codexAccountLaunchState';

const run = promisify(execFile);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ESRCH';

/** daemon 重启后，核对旧 worker 的本地身份并等待退出，避免同一会话出现两个执行进程。 */
export async function stopDetachedCodexWorker(options: {
    pid?: number; sessionId: string; machineId: string; profileId?: string; homesRoot: string;
}): Promise<void> {
    const { pid } = options;
    if (!pid || pid === process.pid || !Number.isSafeInteger(pid) || pid < 1) return;
    try { process.kill(pid, 0); } catch (error) { if (missing(error)) return; throw error; }
    const { stdout } = await run('ps', ['eww', '-p', String(pid), '-o', 'command='], { maxBuffer: 1024 * 1024 });
    const command = stdout.trim();
    const home = command.match(/(?:^|\s)CODEX_HOME=(\S+)/)?.[1];
    if (!home || dirname(resolve(home)) !== resolve(options.homesRoot)
        || !basename(home).startsWith('happy-codex-home-')
        || !/(?:\/codexWorkerEntry\.mjs|\/index\.mjs)\s+codex(?:\s|$)/.test(command)) {
        throw new Error('Cannot verify the previous Codex worker; replacement was not started.');
    }
    const state = await readCodexAccountLaunchState(home);
    if (state.machineId !== options.machineId || state.sourceSessionId !== options.sessionId
        || state.profileId !== options.profileId || state.identityInvalid) {
        throw new Error('Previous Codex worker ownership does not match this session.');
    }
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (missing(error)) return; throw error; }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch (error) { if (missing(error)) return; throw error; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The previous Codex worker did not stop cleanly; replacement was not started.');
}
