import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as crossSpawn } from 'cross-spawn';

import type { SandboxConfig } from '@/persistence';
import { initializeSandbox as defaultInitializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import type { ReasoningEffort } from './codexAppServerTypes';
import type { CodexPermissionMode } from './modeState';
import type { CodexLauncherResult } from './modeLoop';
import { discoverCodexThreadId } from './codexThreadDiscovery';

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'kill' | 'once'>;
type DiscoverThreadIdFn = typeof discoverCodexThreadId;
type InitializeSandboxFn = typeof defaultInitializeSandbox;
type WrapForSandboxFn = typeof wrapForMcpTransport;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDiscoveredThreadId(opts: {
    discoverThreadId: DiscoverThreadIdFn;
    codexHomeDir: string;
    cwd: string;
    startedAt: Date;
    now: () => Date;
    pollMs: number;
    signal: AbortSignal;
}): Promise<string> {
    while (!opts.signal.aborted) {
        try {
            return await opts.discoverThreadId({
                codexHomeDir: opts.codexHomeDir,
                cwd: opts.cwd,
                startedAt: opts.startedAt,
                finishedAt: opts.now(),
            });
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Ambiguous Codex thread discovery')) {
                throw error;
            }
        }
        await delay(opts.pollMs);
    }

    throw new Error(`Codex thread discovery cancelled for cwd ${opts.cwd}.`);
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
    sandboxConfig?: SandboxConfig;
    spawn?: SpawnFn;
    initializeSandbox?: InitializeSandboxFn;
    wrapForSandbox?: WrapForSandboxFn;
    now?: () => Date;
    discoverThreadId?: DiscoverThreadIdFn;
    discoveryPollMs?: number;
    onThreadIdDiscovered?: (threadId: string) => void;
    onLocalHandoffReady?: (handoff: () => void) => void;
    onTerminateReady?: (terminate: () => void) => void;
}): Promise<CodexLauncherResult> {
    const spawn = opts.spawn ?? crossSpawn;
    const now = opts.now ?? (() => new Date());
    const startedAt = now();
    let sandboxCleanup: (() => Promise<void>) | null = null;

    try {
        let command = 'codex';
        let args = buildCodexNativeArgs(opts);
        if (opts.sandboxConfig?.enabled && process.platform !== 'win32') {
            const initializeSandbox = opts.initializeSandbox ?? defaultInitializeSandbox;
            const wrapForSandbox = opts.wrapForSandbox ?? wrapForMcpTransport;
            sandboxCleanup = await initializeSandbox(opts.sandboxConfig, opts.cwd);
            const wrapped = await wrapForSandbox(command, args);
            command = wrapped.command;
            args = wrapped.args;
        }

        const child = spawn(command, args, {
            cwd: opts.cwd,
            stdio: 'inherit',
            env: process.env,
        });
        let discoveredThreadId = opts.codexThreadId;
        let handoffRequested = false;
        opts.onTerminateReady?.(() => {
            child.kill('SIGTERM');
        });
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
        const discoveryAbort = new AbortController();
        const discoveryPromise: Promise<{ kind: 'discovery'; status: 'fulfilled'; threadId: string } | { kind: 'discovery'; status: 'rejected'; error: unknown }> = (opts.codexThreadId
            ? Promise.resolve(opts.codexThreadId)
            : waitForDiscoveredThreadId({
                discoverThreadId,
                codexHomeDir,
                cwd: opts.cwd,
                startedAt,
                now,
                pollMs: opts.discoveryPollMs ?? 250,
                signal: discoveryAbort.signal,
            }).then((threadId) => {
                discoveredThreadId = threadId;
                opts.onThreadIdDiscovered?.(threadId);
                if (handoffRequested) {
                    child.kill('SIGTERM');
                }
                return threadId;
            }))
            .then(
                (threadId) => ({ kind: 'discovery' as const, status: 'fulfilled' as const, threadId }),
                (error) => ({ kind: 'discovery' as const, status: 'rejected' as const, error }),
            );

        const exitPromise = new Promise<{ kind: 'exit'; status: 'fulfilled'; code: number } | { kind: 'exit'; status: 'rejected'; error: unknown }>((resolve) => {
            child.once('error', reject);
            child.once('exit', (code) => {
                discoveryAbort.abort();
                resolve({ kind: 'exit', status: 'fulfilled', code: typeof code === 'number' ? code : 1 });
            });
            function reject(error: unknown): void {
                discoveryAbort.abort();
                resolve({ kind: 'exit', status: 'rejected', error });
            }
        });

        const first = await Promise.race([discoveryPromise, exitPromise]);
        if (first.kind === 'exit') {
            if (first.status === 'rejected') {
                throw first.error;
            }
            if (handoffRequested && discoveredThreadId) {
                return { type: 'switch', codexThreadId: discoveredThreadId };
            }
            return { type: 'exit', code: first.code, ...(discoveredThreadId ? { codexThreadId: discoveredThreadId } : {}) };
        }

        if (first.status === 'rejected') {
            child.kill('SIGTERM');
            await exitPromise;
            throw first.error;
        }

        const exit = await exitPromise;
        if (exit.status === 'rejected') {
            throw exit.error;
        }
        if (handoffRequested) {
            return { type: 'switch', codexThreadId: first.threadId };
        }

        return { type: 'exit', code: exit.code, codexThreadId: first.threadId };
    } finally {
        if (sandboxCleanup) {
            await sandboxCleanup();
        }
    }
}
