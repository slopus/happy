/**
 * Workspace bootstrap for the AX Studio step workflow.
 *
 * Idempotently provisions the files every workspace needs:
 *   - `.ax/state.json`         — Source of Truth, created at the requested step
 *   - `.ax/events.jsonl`       — empty append-only audit log
 *
 * Additionally, cleans up stale `PreToolUse` hook entries left in
 * `.claude/settings.json` by older bootstraps. The hook was removed in
 * specs/20260522-ax-step-free-mode.
 *
 * If `state.json` already exists and is valid, we leave it untouched so a
 * second bootstrap call never clobbers the user's progress.
 */

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { AxStep, createInitialState } from './schema';
import { writeState, readState, StateFileCorruptError } from './io';

const STALE_HOOK_COMMAND = 'happy hooks pre-tool-use';

export async function bootstrapWorkspace(workspaceRoot: string, step: AxStep): Promise<void> {
    await mkdir(join(workspaceRoot, '.ax'), { recursive: true });
    await ensureState(workspaceRoot, step);
    await ensureEventsFile(workspaceRoot);
    await cleanupStaleHookSettings(workspaceRoot);
}

async function ensureState(workspaceRoot: string, step: AxStep): Promise<void> {
    try {
        await readState(workspaceRoot);
        return;
    } catch (err) {
        if (err instanceof StateFileCorruptError) {
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

/**
 * Strips legacy `happy hooks pre-tool-use` entries from
 * `.claude/settings.json`. No-op if the file is absent or has no such
 * entry. Preserves all other settings keys and other hook entries.
 */
async function cleanupStaleHookSettings(workspaceRoot: string): Promise<void> {
    const path = join(workspaceRoot, '.claude', 'settings.json');

    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
    }

    let settings: ClaudeSettings;
    try {
        settings = JSON.parse(raw) as ClaudeSettings;
    } catch {
        return;
    }

    const entries = settings.hooks?.PreToolUse;
    if (!Array.isArray(entries)) return;

    const filtered = entries
        .map((entry) => ({
            ...entry,
            hooks: entry.hooks.filter((h) => h.command !== STALE_HOOK_COMMAND),
        }))
        .filter((entry) => entry.hooks.length > 0);

    if (filtered.length === entries.length) {
        const allKept = entries.every(
            (entry, i) => entry.hooks.length === filtered[i].hooks.length,
        );
        if (allKept) return;
    }

    if (filtered.length === 0) {
        delete settings.hooks!.PreToolUse;
        if (Object.keys(settings.hooks!).length === 0) {
            delete settings.hooks;
        }
    } else {
        settings.hooks!.PreToolUse = filtered;
    }

    await writeFile(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
