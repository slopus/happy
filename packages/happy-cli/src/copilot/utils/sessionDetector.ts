/**
 * Copilot Session ID Detection
 * 
 * Utilities for detecting and tracking Copilot CLI session IDs.
 * Copilot stores sessions in ~/.copilot/session-state/<uuid>/
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

const COPILOT_SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');

/**
 * Find the most recently modified Copilot session in ~/.copilot/session-state/
 */
export function findLatestCopilotSession(): string | null {
    try {
        const entries = readdirSync(COPILOT_SESSION_STATE_DIR);
        let latest: { id: string; mtime: number } | null = null;

        for (const entry of entries) {
            // Session IDs are UUIDs
            if (!isUUID(entry)) continue;

            try {
                const stat = statSync(join(COPILOT_SESSION_STATE_DIR, entry));
                if (stat.isDirectory()) {
                    const mtime = stat.mtimeMs;
                    if (!latest || mtime > latest.mtime) {
                        latest = { id: entry, mtime };
                    }
                }
            } catch {
                // Skip inaccessible entries
            }
        }

        if (latest) {
            logger.debug(`[CopilotSession] Found latest session: ${latest.id}`);
        }
        return latest?.id ?? null;
    } catch {
        return null;
    }
}

/**
 * Check if a Copilot session exists on disk
 */
export function copilotSessionExists(sessionId: string): boolean {
    try {
        const sessionDir = join(COPILOT_SESSION_STATE_DIR, sessionId);
        return statSync(sessionDir).isDirectory();
    } catch {
        return false;
    }
}

function isUUID(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
