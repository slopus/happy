import { logger } from "@/ui/logger";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectPath } from "./path";

export function claudeCheckSession(sessionId: string, path: string, transcriptPath?: string | null) {
    const projectDir = getProjectPath(path);

    // Prefer explicit transcript path (from Claude hook) over the project-dir heuristic.
    const sessionFile = transcriptPath ?? join(projectDir, `${sessionId}.jsonl`);
    const sessionExists = existsSync(sessionFile);
    if (!sessionExists) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
        return false;
    }

    // Check if session contains any messages with valid ID fields
    const sessionData = readFileSync(sessionFile, 'utf-8').split('\n');

    const hasGoodMessage = !!sessionData.find((v, index) => {
        if (!v.trim()) return false;  // Skip empty lines silently (not errors)

        try {
            const parsed = JSON.parse(v);
            // Accept sessions with any of these ID fields (different Claude Code versions)
            // Check for non-empty strings to handle edge cases robustly
            return (typeof parsed.uuid === 'string' && parsed.uuid.length > 0) ||        // Claude Code 2.1.x
                   (typeof parsed.messageId === 'string' && parsed.messageId.length > 0) ||   // Older Claude Code
                   (typeof parsed.leafUuid === 'string' && parsed.leafUuid.length > 0);      // Summary lines
        } catch (e) {
            // Log parse errors for debugging (following project convention)
            logger.debug(`[claudeCheckSession] Malformed JSON at line ${index + 1}:`, e);
            return false;
        }
    });

    // Log final validation result for observability
    logger.debug(`[claudeCheckSession] Session ${sessionId}: ${hasGoodMessage ? 'valid' : 'invalid'}`);

    return hasGoodMessage;
}
