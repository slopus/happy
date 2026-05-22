/**
 * CLI shim for the AX Studio PreToolUse hook.
 *
 * The hook was removed in specs/20260522-ax-step-free-mode. This shim exists
 * only for **backwards compatibility** with existing workspaces whose
 * `.claude/settings.json` still references `happy hooks pre-tool-use`.
 *
 * Behavior: drain stdin (so Claude Code's pipe closes cleanly), exit 0 with
 * no output. The next `ax:bootstrap` removes the stale settings entry
 * automatically via `cleanupStaleHookSettings`.
 */

import { Readable } from 'node:stream';

export interface RunPreToolUseCliOptions {
    cwd: string;
    stdin: Readable;
    stdout: { write(chunk: string): boolean };
    stderr?: { write(chunk: string): boolean };
}

export async function runPreToolUseCli(opts: RunPreToolUseCliOptions): Promise<number> {
    for await (const _ of opts.stdin) {
        // drain; intentionally ignored
    }
    return 0;
}
