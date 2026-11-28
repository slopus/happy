import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectPath } from './path';
import { claudeCheckSession } from './claudeCheckSession';
import { logger } from '@/ui/logger';

const CURRENT_SESSION_FILE = '.current-session';

/**
 * Writes the current session ID to a marker file in the working directory.
 * This lets all clients (desktop CLI, mobile, web) consistently resume the
 * same session even after a server URL change or reconnect.
 */
export function writeCurrentSession(workingDirectory: string, sessionId: string): void {
    try {
        writeFileSync(join(workingDirectory, CURRENT_SESSION_FILE), sessionId + '\n', 'utf8');
    } catch (e) {
        logger.debug('[writeCurrentSession] Failed to write marker:', e);
    }
}

/**
 * Finds the most recently modified VALID session in the project directory.
 * A valid session must:
 * 1. Contain at least one message with a uuid, messageId, or leafUuid field
 * 2. Have a session ID in UUID format (Claude Code v2.0.65+ requires this for --resume)
 *
 * Checks .current-session marker file first so that all clients (desktop CLI,
 * mobile, web) resume the same session even after a server URL change or reconnect.
 *
 * Note: Agent sessions (agent-*) are excluded because --resume only accepts UUID format.
 * Returns the session ID (filename without .jsonl extension) or null if no valid sessions found.
 */
export function claudeFindLastSession(workingDirectory: string): string | null {
    try {
        const projectDir = getProjectPath(workingDirectory);

        // UUID format pattern (8-4-4-4-12 hex digits)
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // Check .current-session marker first — shared across all clients for this workspace
        try {
            const markerPath = join(workingDirectory, CURRENT_SESSION_FILE);
            const pinned = readFileSync(markerPath, 'utf8').trim();
            if (uuidPattern.test(pinned) && claudeCheckSession(pinned, workingDirectory)) {
                logger.debug(`[claudeFindLastSession] Resuming pinned session: ${pinned}`);
                return pinned;
            }
        } catch {
            // No marker file or invalid content — fall through to mtime-based search
        }

        const files = readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
                const sessionId = f.replace('.jsonl', '');

                // Filter out non-UUID session IDs (e.g., agent-* sessions)
                // Claude Code --resume only accepts UUID format as of v2.0.65
                if (!uuidPattern.test(sessionId)) {
                    return null;
                }

                // Check if this is a valid session (has messages with uuid field)
                if (claudeCheckSession(sessionId, workingDirectory)) {
                    return {
                        name: f,
                        sessionId: sessionId,
                        mtime: statSync(join(projectDir, f)).mtime.getTime()
                    };
                }
                return null;
            })
            .filter(f => f !== null)
            .sort((a, b) => b.mtime - a.mtime); // Most recent valid session first

        const found = files.length > 0 ? files[0].sessionId : null;
        if (found) {
            writeCurrentSession(workingDirectory, found);
        }
        return found;
    } catch (e) {
        logger.debug('[claudeFindLastSession] Error finding sessions:', e);
        return null;
    }
}
