import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/integrations/watcher/startFileWatcher";
import { getProjectPath } from "./path";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

export type SessionScannerSessionInfo = {
    sessionId: string;
    transcriptPath?: string | null;
};

export async function createSessionScanner(opts: {
    sessionId: string | null,
    /**
     * Optional absolute transcript file path for the initial sessionId (from Claude's SessionStart hook).
     * When provided, it is used instead of the `getProjectPath()` heuristic.
     */
    transcriptPath?: string | null,
    /**
     * Optional Claude config dir override (e.g., when the child process runs with CLAUDE_CONFIG_DIR set).
     * Used only for the heuristic project-dir fallback when transcriptPath is not available.
     */
    claudeConfigDir?: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    onTranscriptMissing?: (info: { sessionId: string; filePath: string }) => void
    /** How long to wait (ms) before warning that the transcript file is missing. Set <= 0 to disable. */
    transcriptMissingWarningMs?: number
}) {

    // Best-effort project directory resolution (fallback).
    // When available, we prefer the Claude hook's transcriptPath-derived directory instead.
    const initialProjectDir = getProjectPath(opts.workingDirectory, opts.claudeConfigDir ?? null);
    let projectDirOverride: string | null = null;
    const sessionFileOverrides = new Map<string, string>();

    const transcriptMissingWarningMs = opts.transcriptMissingWarningMs ?? 5000;
    const warnedMissingTranscripts = new Set<string>();
    const missingTranscriptTimers = new Map<string, NodeJS.Timeout>();

    function effectiveProjectDir(): string {
        return projectDirOverride ?? initialProjectDir;
    }

    function getSessionFilePath(sessionId: string): string {
        const override = sessionFileOverrides.get(sessionId);
        return override ?? join(effectiveProjectDir(), `${sessionId}.jsonl`);
    }

    function scheduleTranscriptMissingWarning(sessionId: string): void {
        if (!opts.onTranscriptMissing) return;
        if (!Number.isFinite(transcriptMissingWarningMs) || transcriptMissingWarningMs <= 0) return;
        if (warnedMissingTranscripts.has(sessionId)) return;
        if (missingTranscriptTimers.has(sessionId)) return;

        const timeoutId = setTimeout(async () => {
            missingTranscriptTimers.delete(sessionId);
            if (warnedMissingTranscripts.has(sessionId)) return;

            const filePath = getSessionFilePath(sessionId);
            try {
                await readFile(filePath, 'utf-8');
                return;
            } catch {
                // still missing (or unreadable)
            }

            warnedMissingTranscripts.add(sessionId);
            try {
                opts.onTranscriptMissing?.({ sessionId, filePath });
            } catch (err) {
                logger.debug('[SESSION_SCANNER] onTranscriptMissing callback threw:', err);
            }
        }, transcriptMissingWarningMs);

        missingTranscriptTimers.set(sessionId, timeoutId);
    }

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, { filePath: string; stop: () => void }>();
    let processedMessageKeys = new Set<string>();

    // If the caller already knows the transcript path for the initial session,
    // apply it before reading any existing messages so we mark the correct history as processed.
    if (opts.sessionId && typeof opts.transcriptPath === 'string' && opts.transcriptPath.trim()) {
        const transcriptPath = opts.transcriptPath.trim();
        sessionFileOverrides.set(opts.sessionId, transcriptPath);
        projectDirOverride = dirname(transcriptPath);
    }

    // Mark existing messages as processed and start watching the initial session
    if (opts.sessionId) {
        let messages = await readSessionLog(getSessionFilePath(opts.sessionId));
        logger.debug(`[SESSION_SCANNER] Marking ${messages.length} existing messages as processed from session ${opts.sessionId}`);
        for (let m of messages) {
            processedMessageKeys.add(messageKey(m));
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
        scheduleTranscriptMissingWarning(opts.sessionId);
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {
        // logger.debug(`[SESSION_SCANNER] Syncing...`);

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            sessions.push(p);
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            const sessionMessages = await readSessionLog(getSessionFilePath(session));
            let skipped = 0;
            let sent = 0;
            for (let file of sessionMessages) {
                let key = messageKey(file);
                if (processedMessageKeys.has(key)) {
                    skipped++;
                    continue;
                }
                processedMessageKeys.add(key);
                logger.debug(`[SESSION_SCANNER] Sending new message: type=${file.type}, uuid=${file.type === 'summary' ? file.leafUuid : file.uuid}`);
                try {
                    opts.onMessage(file);
                    sent++;
                } catch (err) {
                    logger.debug('[SESSION_SCANNER] onMessage callback threw:', err);
                }
            }
            if (sessionMessages.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionMessages.length}, skipped=${skipped}, sent=${sent}`);
            }
        }

        // Move pending sessions to finished sessions (but keep processing them via watchers)
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers for all sessions
        for (let p of sessions) {
            const desiredPath = getSessionFilePath(p);
            const existing = watchers.get(p);

            if (!existing) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watchers.set(p, { filePath: desiredPath, stop: startFileWatcher(desiredPath, () => { sync.invalidate(); }) });
                continue;
            }

            if (existing.filePath !== desiredPath) {
                logger.debug(`[SESSION_SCANNER] Restarting watcher for session: ${p} (${existing.filePath} -> ${desiredPath})`);
                existing.stop();
                watchers.set(p, { filePath: desiredPath, stop: startFileWatcher(desiredPath, () => { sync.invalidate(); }) });
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w.stop();
            }
            watchers.clear();
            for (const timeoutId of missingTranscriptTimers.values()) {
                clearTimeout(timeoutId);
            }
            missingTranscriptTimers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: (arg: string | SessionScannerSessionInfo) => {
            const sessionId = typeof arg === 'string' ? arg : arg.sessionId;
            const transcriptPathRaw = typeof arg === 'string' ? null : arg.transcriptPath;
            const transcriptPath = typeof transcriptPathRaw === 'string' && transcriptPathRaw.trim() ? transcriptPathRaw : null;

            let didUpdatePaths = false;
            if (transcriptPath) {
                const prevOverride = sessionFileOverrides.get(sessionId);
                if (prevOverride !== transcriptPath) {
                    sessionFileOverrides.set(sessionId, transcriptPath);
                    didUpdatePaths = true;
                }
                const nextProjectDir = dirname(transcriptPath);
                if (!projectDirOverride || projectDirOverride !== nextProjectDir) {
                    projectDirOverride = nextProjectDir;
                    didUpdatePaths = true;
                }
            }

            if (currentSessionId === sessionId) {
                if (didUpdatePaths) {
                    sync.invalidate();
                } else {
                    logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                }
                return;
            }
            if (finishedSessions.has(sessionId)) {
                if (didUpdatePaths) sync.invalidate();
                else logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                if (didUpdatePaths) sync.invalidate();
                else logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            scheduleTranscriptMissingWarning(sessionId);
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

/**
 * Read and parse session log file
 * Returns only valid conversation messages, silently skipping internal events
 */
async function readSessionLog(sessionFilePath: string): Promise<RawJSONLines[]> {
    logger.debug(`[SESSION_SCANNER] Reading session file: ${sessionFilePath}`);
    let file: string;
    try {
        file = await readFile(sessionFilePath, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${sessionFilePath}`);
        return [];
    }
    let lines = file.split('\n');
    let messages: RawJSONLines[] = [];
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped
                // They will be tracked by processedMessageKeys to avoid reprocessing
                continue;
            }
            messages.push(parsed.data);
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return messages;
}
