/**
 * Starts a process inside the configured sandbox for the Claude Agent SDK.
 *
 * The SDK's `spawnClaudeCodeProcess` hook must return a process synchronously,
 * but wrapping a command for the sandbox is asynchronous. The returned process
 * hands the SDK its stdin/stdout right away and connects them to the real,
 * wrapped process once it has started. The sandbox must be initialized first
 * (`initializeSandbox`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@/ui/logger';
import { wrapCommand } from './manager';

function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function spawnSandboxedProcess(options: SpawnOptions): SpawnedProcess {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let child: ChildProcess | null = null;
    let pendingKill: NodeJS.Signals | null = null;
    let killed = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        exitCode = code;
        signalCode = signal;
        stdout.end();
        events.emit('exit', code, signal);
    };

    const commandLine = [options.command, ...options.args].map(quoteShellArg).join(' ');
    wrapCommand(commandLine).then((wrapped) => {
        child = spawn(wrapped, [], {
            shell: true,
            cwd: options.cwd,
            env: options.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        stdin.pipe(child.stdin!);
        child.stdout!.pipe(stdout, { end: false });
        child.stderr!.on('data', (chunk: Buffer) => logger.debug(`[sandbox] ${chunk.toString().trimEnd()}`));
        child.on('error', (error) => events.emit('error', error));
        child.on('exit', finish);
        if (pendingKill) {
            child.kill(pendingKill);
        }
    }).catch((error: unknown) => {
        events.emit('error', error instanceof Error ? error : new Error(String(error)));
        finish(1, null);
    });

    options.signal?.addEventListener('abort', () => sandboxed.kill('SIGTERM'), { once: true });

    const sandboxed: SpawnedProcess = {
        stdin,
        stdout,
        get killed() { return killed; },
        get exitCode() { return exitCode; },
        get signalCode() { return signalCode; },
        kill(signal: NodeJS.Signals) {
            killed = true;
            if (child) {
                return child.kill(signal);
            }
            pendingKill = signal;
            return true;
        },
        on: (event: string, listener: (...args: any[]) => void) => { events.on(event, listener); },
        once: (event: string, listener: (...args: any[]) => void) => { events.once(event, listener); },
        off: (event: string, listener: (...args: any[]) => void) => { events.off(event, listener); },
    };
    return sandboxed;
}
