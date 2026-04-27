import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

/**
 * Append a prompt entry to Claude Code's history.jsonl.
 *
 * Mirrors the native CLI behavior: each user prompt gets one entry.
 * This enables /resume discovery, Ctrl+R search, and arrow-key recall
 * for sessions created via the SDK (remote mode).
 *
 * Claude Code's interactive CLI calls its internal Mb6() on every prompt,
 * buffering entries and flushing to history.jsonl on exit. In SDK mode
 * (--output-format stream-json) messages are piped in and Mb6() is never
 * called, so history.jsonl is never written. This function fills that gap.
 *
 * Format matches Claude Code's internal schema exactly:
 * { display, pastedContents, timestamp, project, sessionId }
 */
export function appendPromptToHistory(opts: {
    sessionId: string;
    project: string;    // absolute path to working directory
    display: string;    // user prompt text
}): void {
    try {
        const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
        const historyPath = join(claudeConfigDir, 'history.jsonl');

        const entry = JSON.stringify({
            display: opts.display,
            pastedContents: {},
            timestamp: Date.now(),
            project: opts.project,
            sessionId: opts.sessionId,
        });

        appendFileSync(historyPath, entry + '\n', { mode: 0o600 });
        logger.debug(`[history] Appended prompt to ${historyPath} for session ${opts.sessionId}`);
    } catch (e) {
        // Non-fatal: never break the session over a history write failure
        logger.debug(`[history] Failed to append to history.jsonl: ${e}`);
    }
}

/**
 * Read the first user prompt from a session JSONL file.
 * Used to back-fill the history entry when onSessionFound fires
 * (the first user message arrives before the session ID is known).
 */
export function readFirstUserPrompt(projectDir: string, sessionId: string): string | null {
    try {
        const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
        const content = readFileSync(jsonlPath, 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            if (obj.type === 'user' && obj.message?.role === 'user' && typeof obj.message.content === 'string') {
                return obj.message.content;
            }
        }
    } catch (e) {
        logger.debug(`[history] Failed to read first user prompt from session ${sessionId}: ${e}`);
    }
    return null;
}
