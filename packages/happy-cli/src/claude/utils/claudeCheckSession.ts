import { logger } from "@/ui/logger";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProjectPath } from "./path";

/**
 * A valid transcript carries an id on one of its first lines, so only the head
 * of the file is worth reading. Reading it whole threw ERR_STRING_TOO_LONG on
 * transcripts past Node's 512 MB string limit, and because this runs on every
 * remote launch the exception surfaced as `[remote]: launch error` and put the
 * whole remote mode into a retry loop.
 */
const HEAD_BYTES = 8 * 1024 * 1024;

function readHeadLines(file: string, maxBytes: number): string[] {
    const { size } = statSync(file);
    const length = Math.min(size, maxBytes);
    const fd = openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(length);
        const bytesRead = readSync(fd, buffer, 0, length, 0);
        const lines = buffer.subarray(0, bytesRead).toString('utf-8').split('\n');
        // The final line is cut off when the file is longer than the window.
        return size > length && lines.length > 1 ? lines.slice(0, -1) : lines;
    } finally {
        closeSync(fd);
    }
}

export function claudeCheckSession(sessionId: string, path: string) {
    const projectDir = getProjectPath(path);

    // Check if session id is in the project dir
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    const sessionExists = existsSync(sessionFile);
    if (!sessionExists) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
        return false;
    }

    // Check if session contains any messages with valid ID fields
    const sessionData = readHeadLines(sessionFile, HEAD_BYTES);

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