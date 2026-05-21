/**
 * CLI wrapper for the AX Studio PreToolUse hook.
 *
 * Claude Code spawns this command for every Write/Edit/MultiEdit tool call,
 * pipes the tool payload on stdin, and reads our decision from stdout
 * (structured JSON) and stderr (free-text reason for denials).
 *
 * Exit codes follow Claude Code's hook contract:
 *   - 0  → allow (or pass an `ask` decision via JSON stdout)
 *   - 2  → deny (stderr is shown back to Claude in the next turn)
 *
 * Non-AX workspaces (`.ax/state.json` absent) are passthrough by design — we
 * exit 0 with no output so other tooling can install their own hooks
 * alongside ours.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { decidePreToolUse, PreToolUseResult } from './preToolUse';
import { readState } from '../orchestrator/state/io';
import { appendEvent } from '../orchestrator/state/io';

export interface RunPreToolUseCliOptions {
    cwd: string;
    stdin: Readable;
    stdout: { write(chunk: string): boolean };
    stderr?: { write(chunk: string): boolean };
}

export async function runPreToolUseCli(opts: RunPreToolUseCliOptions): Promise<number> {
    const stderr = opts.stderr ?? { write: () => true };

    const raw = await collectStdin(opts.stdin);
    let payload: { tool_name?: unknown; tool_input?: unknown };
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0;
    }
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    const toolInput =
        payload.tool_input && typeof payload.tool_input === 'object'
            ? (payload.tool_input as Record<string, unknown>)
            : {};

    let state;
    try {
        state = await readState(opts.cwd);
    } catch {
        // Non-AX workspace, or corrupt state: passthrough so the user can self-heal.
        return 0;
    }

    const result = decidePreToolUse({ cwd: opts.cwd, toolName, toolInput, state });

    switch (result.decision) {
        case 'allow':
            return 0;
        case 'deny':
            await logBlocked(opts.cwd, toolName, toolInput, result.reason ?? '');
            stderr.write(`${result.reason ?? 'Blocked by AX Studio PreToolUse hook.'}\n`);
            return 2;
        case 'ask':
            opts.stdout.write(
                JSON.stringify({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'ask',
                        permissionDecisionReason: result.reason ?? 'AX Studio approval required.',
                        axPermissionTarget: result.permissionTarget,
                    },
                }) + '\n',
            );
            return 0;
    }
}

async function collectStdin(stream: Readable): Promise<string> {
    let out = '';
    for await (const chunk of stream) {
        out += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    }
    return out;
}

async function logBlocked(
    cwd: string,
    tool: string,
    toolInput: Record<string, unknown>,
    reason: string,
): Promise<void> {
    try {
        await appendEvent(cwd, {
            id: `evt_${randomUUID()}`,
            at: new Date().toISOString(),
            type: 'hook.blocked',
            payload: {
                tool,
                file_path: typeof toolInput.file_path === 'string' ? toolInput.file_path : null,
                reason,
            },
        });
    } catch {
        // never let logging failure cascade into a wrong decision
    }
}
