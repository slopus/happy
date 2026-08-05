/**
 * Locating Kimi Code CLI sessions on disk.
 *
 * Kimi keeps an append-only index at `<kimiHome>/session_index.jsonl` with one
 * `{ sessionId, sessionDir, workDir }` record per session, and stores the live
 * transcript at `<sessionDir>/agents/main/wire.jsonl`. Both the local TUI and
 * `kimi acp` write to this same store, which is what lets a session started in
 * the terminal be handed to the ACP backend (and back) without losing history.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { logger } from '@/ui/logger';

export type KimiSessionIndexEntry = {
    sessionId: string;
    sessionDir: string;
    workDir: string;
};

/** Root of the Kimi Code data directory, honouring its own env override. */
export function kimiHomeDir(): string {
    return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

export function kimiSessionIndexPath(): string {
    return join(kimiHomeDir(), 'session_index.jsonl');
}

/** Live transcript for a session directory. */
export function kimiWirePath(sessionDir: string): string {
    return join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

/**
 * Read the session index. Returns an empty list when the file does not exist
 * yet — a fresh Kimi install has no sessions.
 */
export async function readKimiSessionIndex(): Promise<KimiSessionIndexEntry[]> {
    let raw: string;
    try {
        raw = await readFile(kimiSessionIndexPath(), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.debug('[kimi] Failed to read session index:', error);
        }
        return [];
    }

    const entries: KimiSessionIndexEntry[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const parsed = JSON.parse(line) as Partial<KimiSessionIndexEntry>;
            if (typeof parsed.sessionId === 'string'
                && typeof parsed.sessionDir === 'string'
                && typeof parsed.workDir === 'string') {
                entries.push(parsed as KimiSessionIndexEntry);
            }
        } catch {
            // A partially flushed trailing line is expected while Kimi is writing.
        }
    }
    return entries;
}

/**
 * Find the newest session for `workDir` that is not in `excluded`. Used to
 * identify the session a freshly spawned Kimi just created: the caller
 * snapshots existing ids first, then polls until a new one shows up.
 */
export async function findNewKimiSession(
    workDir: string,
    excluded: ReadonlySet<string>,
): Promise<KimiSessionIndexEntry | null> {
    const entries = await readKimiSessionIndex();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.workDir === workDir && !excluded.has(entry.sessionId)) {
            return entry;
        }
    }
    return null;
}
