import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readCodexAccountLaunchState } from '@/codex/codexAccountLaunchState';
import { CodexAccountLaunch, type AccountApi } from '@/daemon/codexAccountLaunch';
import { processAlive } from './workerLock';
import { canRecoverRuntimeProcess } from './runtimeProcessState';

async function untouchedJob(root: string): Promise<boolean> {
    const paths = ['.runtime-started', '.runtime-pid', '.runtime-process.json', 'codex/auth.json', 'codex/.paws-account-launch.json'];
    const evidence = await Promise.all(paths.map(path => access(join(root, path)).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    })));
    return evidence.every(exists => !exists);
}

export async function recoverAppChatCredentialJobs(recoveryRoot: string, machineId: string, api: AccountApi, activeHomes: ReadonlySet<string> = new Set()): Promise<boolean> {
    if ([...activeHomes].some(home => home.startsWith(recoveryRoot))) return false;
    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(recoveryRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
        const root = join(recoveryRoot, entry.name), home = join(root, 'codex');
        try {
            const state = await readCodexAccountLaunchState(home);
            if (state.machineId !== machineId) return false;
            if (state.daemonPid !== process.pid && processAlive(state.daemonPid)) return false;
            if (!await canRecoverRuntimeProcess(root)) return false;
            await CodexAccountLaunch.recover(api, home, state).syncProbeCredential();
            await rm(root, { recursive: true, force: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await untouchedJob(root)) { await rm(root, { recursive: true, force: true }); continue; }
            return false;
        } // Never discard an unsaved refresh or start another refresh.
    }
    return true;
}
