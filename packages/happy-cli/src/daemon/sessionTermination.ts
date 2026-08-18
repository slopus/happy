import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import psList, { type ProcessDescriptor } from 'ps-list';

import type { TrackedSession } from './types';
import { projectPath } from '@/projectPath';

const execFileAsync = promisify(execFile);
const DEFAULT_GRACE_MS = 3_000;
const POLL_MS = 50;

type KillProcess = (pid: number, signal: NodeJS.Signals | 0) => void;

function waitForExit(
    pid: number,
    timeoutMs: number,
    killProcess: KillProcess,
): Promise<boolean> {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
            try {
                killProcess(pid, 0);
            } catch {
                resolve(true);
                return;
            }
            if (Date.now() >= deadline) {
                resolve(false);
                return;
            }
            setTimeout(poll, POLL_MS);
        };
        poll();
    });
}

function signalIfAlive(pid: number, signal: NodeJS.Signals, killProcess: KillProcess): boolean {
    try {
        killProcess(pid, signal);
        return true;
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'ESRCH') return false;
        throw error;
    }
}

export async function terminateDetachedProcessTree(
    pid: number,
    options: {
        platform?: NodeJS.Platform;
        graceMs?: number;
        killProcess?: KillProcess;
        runTaskkill?: (args: string[]) => Promise<void>;
    } = {},
): Promise<void> {
    const platform = options.platform ?? process.platform;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const killProcess = options.killProcess ?? process.kill.bind(process);

    if (platform === 'win32') {
        const runTaskkill = options.runTaskkill ?? (async (args) => {
            await execFileAsync('taskkill', args, { windowsHide: true });
        });
        try {
            await runTaskkill(['/PID', String(pid), '/T']);
        } catch {
            await runTaskkill(['/F', '/PID', String(pid), '/T']);
        }
        return;
    }

    // Give the Happy root process a chance to flush session state and close its
    // SDK/MCP children. It is a process-group leader because daemon spawning
    // uses detached:true on POSIX.
    signalIfAlive(pid, 'SIGTERM', killProcess);
    if (await waitForExit(pid, graceMs, killProcess)) {
        // The root may have exited before one of its descendants. Signal the
        // original detached group once more to reap anything it left behind.
        try { killProcess(-pid, 'SIGTERM'); } catch { }
        if (!(await waitForExit(-pid, Math.min(graceMs, 1_000), killProcess))) {
            try { killProcess(-pid, 'SIGKILL'); } catch { }
        }
        return;
    }

    try { killProcess(-pid, 'SIGTERM'); } catch { }
    if (await waitForExit(-pid, Math.min(graceMs, 1_000), killProcess)) return;

    // The identity came from an in-memory ChildProcess owned by this daemon (or
    // a freshly revalidated orphan scan), so escalating the detached group is
    // safer than leaving an unbounded SDK/MCP tree behind.
    try { killProcess(-pid, 'SIGKILL'); } catch {
        signalIfAlive(pid, 'SIGKILL', killProcess);
    }
}

export async function terminateTrackedSession(
    session: TrackedSession,
    options: {
        terminateTree?: (pid: number) => Promise<void>;
        killTmuxWindow?: (sessionId: string) => Promise<boolean>;
    } = {},
): Promise<void> {
    if (session.tmuxSessionId) {
        if (!options.killTmuxWindow) {
            throw new Error(`Cannot terminate tmux session ${session.tmuxSessionId}: no tmux window terminator`);
        }
        const killed = await options.killTmuxWindow(session.tmuxSessionId);
        if (!killed) throw new Error(`Failed to terminate tmux session ${session.tmuxSessionId}`);
        return;
    }
    await (options.terminateTree ?? terminateDetachedProcessTree)(session.pid);
}

export async function terminateDaemonOwnedSessions(
    sessions: Iterable<TrackedSession>,
    options: Parameters<typeof terminateTrackedSession>[1] = {},
): Promise<{ terminated: number; errors: Array<{ pid: number; error: string }> }> {
    const owned = Array.from(sessions).filter((session) => session.startedBy === 'daemon');
    const results = await Promise.all(owned.map(async (session) => {
        try {
            await terminateTrackedSession(session, options);
            return { pid: session.pid, ok: true as const };
        } catch (error) {
            return {
                pid: session.pid,
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }));
    return {
        terminated: results.filter((result) => result.ok).length,
        errors: results.flatMap((result) => result.ok ? [] : [{ pid: result.pid, error: result.error }]),
    };
}

function descendantPids(processes: ProcessDescriptor[], rootPid: number): number[] {
    const byParent = new Map<number, number[]>();
    for (const item of processes) {
        const children = byParent.get(item.ppid) ?? [];
        children.push(item.pid);
        byParent.set(item.ppid, children);
    }
    const descendants: number[] = [];
    const visit = (pid: number) => {
        for (const child of byParent.get(pid) ?? []) {
            visit(child);
            descendants.push(child);
        }
    };
    visit(rootPid);
    return descendants;
}

async function terminateDiscoveredProcessTree(
    rootPid: number,
    listProcesses: () => Promise<ProcessDescriptor[]>,
): Promise<void> {
    const descendants = descendantPids(await listProcesses(), rootPid);
    try { process.kill(rootPid, 'SIGTERM'); } catch { return; }
    if (await waitForExit(rootPid, DEFAULT_GRACE_MS, process.kill.bind(process))) {
        for (const pid of descendants) {
            try { process.kill(pid, 'SIGTERM'); } catch { }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        for (const pid of descendants) {
            try { process.kill(pid, 'SIGKILL'); } catch { }
        }
        return;
    }

    // tmux-owned roots are not process-group leaders. Walk their current PPID
    // tree leaf-first instead of assuming `-rootPid` identifies a group.
    for (const pid of descendants) {
        try { process.kill(pid, 'SIGTERM'); } catch { }
    }
    try { process.kill(rootPid, 'SIGTERM'); } catch { }
    await new Promise(resolve => setTimeout(resolve, 500));
    for (const pid of descendants) {
        try { process.kill(pid, 'SIGKILL'); } catch { }
    }
    try { process.kill(rootPid, 'SIGKILL'); } catch { }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isDaemonSpawnedSessionProcess(
    processInfo: ProcessDescriptor,
    expectedEntrypoint = join(projectPath(), 'dist', 'index.mjs'),
): boolean {
    if (!processInfo.cmd || processInfo.pid === process.pid) return false;
    if (typeof process.getuid === 'function' && processInfo.uid !== undefined && processInfo.uid !== process.getuid()) return false;

    const command = processInfo.cmd;
    const isHappyEntrypoint = new RegExp(`(?:^|\\s)["']?${escapeRegExp(expectedEntrypoint)}["']?(?:\\s|$)`).test(command);
    const hasDaemonMarker = /(?:^|\s)--started-by(?:\s+|=)["']?daemon["']?(?:\s|$)/.test(command);
    const hasSupportedAgent = /(?:^|\s)(?:claude|codex|gemini|openclaw|agy)(?:\s|$)/.test(command);
    return isHappyEntrypoint && hasDaemonMarker && hasSupportedAgent;
}

export async function reapOrphanedDaemonSessions(options: {
    listProcesses?: () => Promise<ProcessDescriptor[]>;
    terminateTree?: (pid: number) => Promise<void>;
    platform?: NodeJS.Platform;
    expectedEntrypoint?: string;
} = {}): Promise<{ terminated: number; errors: Array<{ pid: number; error: string }> }> {
    if ((options.platform ?? process.platform) === 'win32') {
        // ps-list does not expose Windows command lines, so matching cannot be
        // made strict enough to signal a PID safely. Graceful shutdown still
        // uses taskkill /T for sessions owned by the current daemon.
        return { terminated: 0, errors: [] };
    }

    const listProcesses = options.listProcesses ?? psList;
    const terminateTree = options.terminateTree ?? ((pid: number) => terminateDiscoveredProcessTree(pid, listProcesses));
    const expectedEntrypoint = options.expectedEntrypoint ?? join(projectPath(), 'dist', 'index.mjs');
    const matchesOwnedSession = (item: ProcessDescriptor) => isDaemonSpawnedSessionProcess(item, expectedEntrypoint);
    // At this point the daemon lock proves there is no previous live daemon.
    // Match both launchd/systemd-reparented roots and tmux-owned roots; the
    // canonical entrypoint + internal marker excludes terminal sessions.
    const candidates = (await listProcesses()).filter(matchesOwnedSession);
    const results = await Promise.all(candidates.map(async (candidate) => {
        try {
            // Revalidate uid and the exact argv marker immediately before
            // signalling to fail closed on PID reuse.
            const current = (await listProcesses()).find((item) => item.pid === candidate.pid);
            if (!current || !matchesOwnedSession(current) || current.cmd !== candidate.cmd) {
                return { pid: candidate.pid, ok: false as const, error: 'process identity changed before cleanup' };
            }
            await terminateTree(candidate.pid);
            return { pid: candidate.pid, ok: true as const };
        } catch (error) {
            return {
                pid: candidate.pid,
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }));
    return {
        terminated: results.filter((result) => result.ok).length,
        errors: results.flatMap((result) => result.ok ? [] : [{ pid: result.pid, error: result.error }]),
    };
}
