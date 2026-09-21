import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertPrivate, exists } from './privateFiles.js';

export interface OwnedProcess {
    readonly done: Promise<{ code: number | null; signal: string | null }>;
    readonly exited: () => boolean;
    stop(): Promise<void>;
}

const exec = promisify(execFile);

/** POSIX process groups keep tsx/Expo descendants within the controller's lifetime. */
export async function processStart(options: {
    cwd: string; args: string[]; env: NodeJS.ProcessEnv; log: string;
}): Promise<OwnedProcess> {
    if (process.platform === 'win32') throw new Error('Mobile gym currently requires macOS or Linux process groups.');
    if (await exists(options.log)) await assertPrivate(options.log);
    const log = await open(options.log, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    let child;
    try {
        const supervisor = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));
        child = spawn(process.execPath, [supervisor, ...options.args], {
            cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'],
        });
    } catch (error) { await log.close(); throw error; }
    let exited = false;
    let supervisorExited = false;
    let ready!: () => void;
    let readyFailed!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; readyFailed = reject; });
    let workloadComplete!: (result: { code: number | null; signal: string | null }) => void;
    const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        workloadComplete = resolve;
        child.on('message', (message: unknown) => {
            if (typeof message !== 'object' || message === null || !('type' in message)) return;
            if (message.type === 'supervisorReady') { ready(); return; }
            if (message.type !== 'workloadExited') return;
            if (!('code' in message) || !(message.code === null || typeof message.code === 'number')
                || !('signal' in message) || !(message.signal === null || typeof message.signal === 'string')) return;
            exited = true;
            resolve({ code: message.code, signal: message.signal });
        });
    });
    const leaderDone = new Promise<void>((resolve) => {
        const leaderExit = () => {
            supervisorExited = true;
            exited = true;
            readyFailed(new Error('Supervisor exited before its ready handshake.'));
            workloadComplete({ code: 1, signal: null });
            resolve();
        };
        child.once('error', leaderExit);
        child.once('exit', leaderExit);
    });
    // Attach the rejection handler before yielding; spawn failure can arrive
    // while the descriptor is being closed.
    await Promise.all([log.close(), started]);
    let stopping: Promise<void> | undefined;
    const hasWorkers = async () => {
        const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { env: options.env });
        return stdout.split('\n').some((line) => {
            const [pid, pgid, state] = line.trim().split(/\s+/u);
            return Number(pgid) === child.pid && Number(pid) !== child.pid && state && !state.startsWith('Z');
        });
    };
    return {
        done,
        exited: () => exited,
        stop: () => stopping ??= (async () => {
            if (supervisorExited) throw new Error('Supervisor lost; process ownership is unproven.');
            await new Promise<void>((resolve, reject) => child.send({ type: 'stop' }, (error) => error ? reject(error) : resolve()));
            await leaderDone;
            // Read-only confirmation after releasing the leader: never signal
            // that group again, even if its numeric ID could now be reused.
            if (await hasWorkers()) throw new Error('Workers remain after supervisor shutdown; retain the owner lock.');
        })(),
    };
}

export async function assertPortFree(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', () => reject(new Error(`Loopback port ${port} is occupied or unavailable; choose explicit free ports.`)));
        probe.listen(port, '127.0.0.1', () => probe.close((error) => error ? reject(error) : resolve()));
    });
}

export async function waitReady(
    child: OwnedProcess, url: string, expected: 'server' | 'metro', signal?: AbortSignal,
): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (child.exited()) throw new Error(`${expected} exited before readiness; inspect its private log.`);
        try {
            const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1_000) });
            const text = await response.text();
            if (expected === 'metro' ? response.ok && text === 'packager-status:running' : response.status === 401) return;
        } catch { /* Startup may not have bound its listener yet. */ }
        await delay(200, undefined, { signal });
    }
    throw new Error(`${expected} readiness timed out; inspect its private log.`);
}