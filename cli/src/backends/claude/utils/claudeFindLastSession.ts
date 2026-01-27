import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectPath } from './path';
import { claudeCheckSession } from './claudeCheckSession';
import { logger } from '@/ui/logger';

/**
 * Finds the most recently modified VALID session in the project directory.
 * A valid session must:
 * 1. Contain at least one message with a uuid, messageId, or leafUuid field
 * 2. Have a session ID in UUID format (Claude Code v2.0.65+ requires this for --resume)
 *
 * Note: Agent sessions (agent-*) are excluded because --resume only accepts UUID format.
 * Returns the session ID (filename without .jsonl extension) or null if no valid sessions found.
 */
export function claudeFindLastSession(workingDirectory: string, claudeConfigDirOverride?: string | null): string | null {
    try {
        const projectDir = getProjectPath(workingDirectory, claudeConfigDirOverride);

        // UUID format pattern (8-4-4-4-12 hex digits)
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
                const transcriptPath = join(projectDir, f);
                if (claudeCheckSession(sessionId, workingDirectory, transcriptPath)) {
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

        return files.length > 0 ? files[0].sessionId : null;
    } catch (e) {
        logger.debug('[claudeFindLastSession] Error finding sessions:', e);
        return null;
    }
}
