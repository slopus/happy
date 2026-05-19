/**
 * Workspace bootstrap for the start-from-planning workflow.
 *
 * Idempotently provisions the three files every workspace needs:
 *   - `.ax/state.json`         — Source of Truth, created at the requested step
 *   - `.ax/events.jsonl`       — empty append-only audit log
 *   - `.claude/settings.json`  — PreToolUse hook wired to the bundled guard
 *
 * If `state.json` already exists and is valid, we leave it untouched so a
 * second bootstrap call never clobbers the user's progress.
 */

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { AxStep, createInitialState } from './schema';
import { writeState, readState, StateFileCorruptError } from './io';

const PRE_TOOL_USE_HOOK_COMMAND = 'happy hooks pre-tool-use';

export async function bootstrapWorkspace(workspaceRoot: string, step: AxStep): Promise<void> {
    await mkdir(join(workspaceRoot, '.ax'), { recursive: true });
    await ensureState(workspaceRoot, step);
    await ensureEventsFile(workspaceRoot);
    await ensureClaudeSettings(workspaceRoot);
}

async function ensureState(workspaceRoot: string, step: AxStep): Promise<void> {
    try {
        await readState(workspaceRoot);
        return;
    } catch (err) {
        if (err instanceof StateFileCorruptError) {
            // Surface explicitly — bootstrap is not responsible for backup/reset
            throw err;
        }
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await writeState(workspaceRoot, createInitialState(step));
}

async function ensureEventsFile(workspaceRoot: string): Promise<void> {
    const path = join(workspaceRoot, '.ax', 'events.jsonl');
    try {
        await access(path);
    } catch {
        await writeFile(path, '', 'utf8');
    }
}

interface ClaudeHookEntry {
    matcher?: string;
    hooks: Array<{ type: string; command: string }>;
}

interface ClaudeSettings {
    hooks?: {
        PreToolUse?: ClaudeHookEntry[];
        [key: string]: ClaudeHookEntry[] | undefined;
    };
    [key: string]: unknown;
}

async function ensureClaudeSettings(workspaceRoot: string): Promise<void> {
    const dir = join(workspaceRoot, '.claude');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'settings.json');

    let settings: ClaudeSettings = {};
    try {
        const raw = await readFile(path, 'utf8');
        settings = JSON.parse(raw) as ClaudeSettings;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    settings.hooks ??= {};
    const entries: ClaudeHookEntry[] = settings.hooks.PreToolUse ?? [];
    const alreadyRegistered = entries.some((entry) =>
        entry.hooks.some((h) => h.command === PRE_TOOL_USE_HOOK_COMMAND),
    );
    if (!alreadyRegistered) {
        entries.push({
            matcher: 'Write|Edit|MultiEdit',
            hooks: [{ type: 'command', command: PRE_TOOL_USE_HOOK_COMMAND }],
        });
    }
    settings.hooks.PreToolUse = entries;

    await writeFile(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
