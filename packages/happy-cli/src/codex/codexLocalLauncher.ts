import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type { ReasoningEffort } from './codexAppServerTypes';
import type { CodexPermissionMode } from './modeState';
import type { CodexLauncherResult } from './modeLoop';

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'once'>;

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
    codexThreadId?: string;
    model?: string;
    effort?: ReasoningEffort;
    permissionMode?: CodexPermissionMode;
    spawn?: SpawnFn;
}): Promise<CodexLauncherResult> {
    const spawn = opts.spawn ?? nodeSpawn;
    const child = spawn('codex', buildCodexNativeArgs(opts), {
        cwd: opts.cwd,
        stdio: 'inherit',
        env: process.env,
    });

    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
            resolve({ type: 'exit', code: typeof code === 'number' ? code : 1 });
        });
    });
}
