import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ReasoningEffort } from './codexAppServerTypes';
import type { CodexPermissionMode } from './modeState';
import type { CodexLauncherResult } from './modeLoop';
import { discoverCodexThreadId } from './codexThreadDiscovery';

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'kill' | 'once'>;
type DiscoverThreadIdFn = typeof discoverCodexThreadId;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDiscoveredThreadId(opts: {
    discoverThreadId: DiscoverThreadIdFn;
    codexHomeDir: string;
    cwd: string;
    startedAt: Date;
    now: () => Date;
    timeoutMs: number;
    pollMs: number;
}): Promise<string> {
    const deadline = opts.startedAt.getTime() + opts.timeoutMs;
    let lastError: unknown = null;

    while (opts.now().getTime() <= deadline) {
        try {
            return await opts.discoverThreadId({
                codexHomeDir: opts.codexHomeDir,
                cwd: opts.cwd,
                startedAt: opts.startedAt,
                finishedAt: opts.now(),
            });
        } catch (error) {
            lastError = error;
            if (error instanceof Error && error.message.startsWith('Ambiguous Codex thread discovery')) {
                throw error;
            }
        }
        await delay(opts.pollMs);
    }

    if (lastError instanceof Error) {
        throw lastError;
    }
    throw new Error(`Could not discover Codex thread id for cwd ${opts.cwd} in launch window.`);
}

export function buildCodexNativeArgs(opts: {
    codexThreadId?: string;
    model?: string;
    effort?: ReasoningEffort;
    permissionMode?: CodexPermissionMode;
}): string[] {
    const args: string[] = [];

    if (opts.codexThreadId) {
        args.push('resume', opts.codexThreadId);
    }

    if (opts.model) {
        args.push('--model', opts.model);
    }

    if (opts.effort) {
        args.push('-c', `model_reasoning_effort="${opts.effort}"`);
    }

    switch (opts.permissionMode) {
        case undefined:
        case 'default':
            break;
        case 'read-only':
            args.push('--ask-for-approval', 'never', '--sandbox', 'read-only');
            break;
        case 'safe-yolo':
            args.push('--ask-for-approval', 'on-failure', '--sandbox', 'workspace-write');
            break;
        case 'yolo':
            args.push('--dangerously-bypass-approvals-and-sandbox');
            break;
    }

    return args;
}

export async function launchNativeCodex(opts: {
    cwd: string;
    codexHomeDir?: string;
    codexThreadId?: string;
    model?: string;
    effort?: ReasoningEffort;
    permissionMode?: CodexPermissionMode;
    spawn?: SpawnFn;
    now?: () => Date;
    discoverThreadId?: DiscoverThreadIdFn;
    discoveryTimeoutMs?: number;
    discoveryPollMs?: number;
    onThreadIdDiscovered?: (threadId: string) => void;
    onLocalHandoffReady?: (handoff: () => void) => void;
}): Promise<CodexLauncherResult> {
    const spawn = opts.spawn ?? nodeSpawn;
    const now = opts.now ?? (() => new Date());
    const startedAt = now();
    const child = spawn('codex', buildCodexNativeArgs(opts), {
        cwd: opts.cwd,
        stdio: 'inherit',
        env: process.env,
    });
    let discoveredThreadId = opts.codexThreadId;
    let handoffRequested = false;
    opts.onLocalHandoffReady?.(() => {
        handoffRequested = true;
        if (discoveredThreadId) {
            child.kill('SIGTERM');
        }
    });

    if (opts.codexThreadId) {
        opts.onThreadIdDiscovered?.(opts.codexThreadId);
    }

    const codexHomeDir = opts.codexHomeDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const discoverThreadId = opts.discoverThreadId ?? discoverCodexThreadId;
    const discoveryPromise: Promise<{ status: 'fulfilled'; threadId: string } | { status: 'rejected'; error: unknown }> = (opts.codexThreadId
        ? Promise.resolve(opts.codexThreadId)
        : waitForDiscoveredThreadId({
            discoverThreadId,
            codexHomeDir,
            cwd: opts.cwd,
            startedAt,
            now,
            timeoutMs: opts.discoveryTimeoutMs ?? 10_000,
            pollMs: opts.discoveryPollMs ?? 250,
        }).then((threadId) => {
            discoveredThreadId = threadId;
            opts.onThreadIdDiscovered?.(threadId);
            if (handoffRequested) {
                child.kill('SIGTERM');
            }
            return threadId;
        }))
        .then(
            (threadId) => ({ status: 'fulfilled' as const, threadId }),
            (error) => ({ status: 'rejected' as const, error }),
        );

    const exitPromise = new Promise<{ status: 'fulfilled'; code: number } | { status: 'rejected'; error: unknown }>((resolve) => {
        child.once('error', reject);
        child.once('exit', (code) => {
            resolve({ status: 'fulfilled', code: typeof code === 'number' ? code : 1 });
        });
        function reject(error: unknown): void {
            resolve({ status: 'rejected', error });
        }
    });

    const first = await Promise.race([discoveryPromise, exitPromise]);
    if (first.status === 'rejected') {
        child.kill('SIGTERM');
        await exitPromise;
        throw first.error;
    }

    const [discovery, exit] = await Promise.all([discoveryPromise, exitPromise]);
    if (discovery.status === 'rejected') {
        child.kill('SIGTERM');
        await exitPromise;
        throw discovery.error;
    }
    if (exit.status === 'rejected') {
        throw exit.error;
    }
    if (handoffRequested) {
        return { type: 'switch', codexThreadId: discovery.threadId };
    }

    return { type: 'exit', code: exit.code, codexThreadId: discovery.threadId };
}
