import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
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

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    /**
     * How long a session transcript may stay absent before its watcher gives
     * up and the session is dropped. Defaults to the startFileWatcher default
     * (60s). Exposed mainly so tests can exercise the drop path quickly.
     */
    missingFileTimeoutMs?: number
    /**
     * Called when a newly-seen transcript record reports a working directory
     * different from the last one — e.g. Claude entered a worktree via the
     * EnterWorktree tool, which fires NO hook. The transcript stays in this
     * project dir (only each record's `cwd` flips), so this is the only place
     * the cwd change is observable. Lets the caller follow it (e.g. update
     * session metadata.path so the app + resume track the worktree).
     */
    onCwdChange?: (newCwd: string) => void
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Track the cwd reported by transcript records so we can fire onCwdChange
    // when Claude switches working directory mid-session (EnterWorktree). Seeded
    // with the launch cwd so the first real switch (and not the initial state)
    // triggers the callback.
    let lastCwd = opts.workingDirectory;

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedMessageKeys = new Set<string>();
    // Sessions whose transcript file never appeared. Their watcher gave up,
    // so we must stop re-reading them and never re-create a watcher for them
    // — otherwise a phantom session id (e.g. a remote launch whose .jsonl is
    // never written) keeps itself alive forever via the watchers map below
    // and spins the CPU / floods the log (the "dead Happy instance" bug).
    let deadSessions = new Set<string>();

    // Mark existing messages as processed and start watching the initial session
    if (opts.sessionId) {
        let messages = await readSessionLog(projectDir, opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${messages.length} existing messages as processed from session ${opts.sessionId}`);
        for (let m of messages) {
            processedMessageKeys.add(messageKey(m));
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            if (!deadSessions.has(p)) {
                sessions.push(p);
            }
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId) && !deadSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId) && !deadSessions.has(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            const sessionMessages = await readSessionLog(projectDir, session);
            let skipped = 0;
            let sent = 0;
            for (let file of sessionMessages) {
                let key = messageKey(file);
                if (processedMessageKeys.has(key)) {
                    skipped++;
                    continue;
                }
                processedMessageKeys.add(key);
                // EnterWorktree (and any mid-session cd) changes the cwd recorded
                // on each transcript record but fires no hook. Detect it here so
                // the caller can follow (e.g. update metadata.path).
                const recordCwd = (file as { cwd?: unknown }).cwd;
                if (typeof recordCwd === 'string' && recordCwd.length > 0 && recordCwd !== lastCwd) {
                    lastCwd = recordCwd;
                    logger.debug(`[SESSION_SCANNER] cwd changed via transcript record: ${recordCwd}`);
                    opts.onCwdChange?.(recordCwd);
                }
                logger.debug(`[SESSION_SCANNER] Sending new message: type=${file.type}, uuid=${file.type === 'summary' ? file.leafUuid : file.uuid}`);
                opts.onMessage(file);
                sent++;
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
            if (!watchers.has(p) && !deadSessions.has(p)) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watchers.set(p, startFileWatcher(
                    join(projectDir, `${p}.jsonl`),
                    () => { sync.invalidate(); },
                    {
                        missingFileTimeoutMs: opts.missingFileTimeoutMs,
                        onGaveUp: () => {
                            // The transcript for this session never appeared.
                            // Tear the watcher down and blacklist the session
                            // so the collection loop above stops resurrecting
                            // it. Without this the phantom session would keep
                            // itself in `watchers` forever.
                            logger.debug(`[SESSION_SCANNER] Session ${p} transcript never appeared — dropping it`);
                            watchers.get(p)?.();
                            watchers.delete(p);
                            deadSessions.add(p);
                            pendingSessions.delete(p);
                        },
                    },
                ));
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
                w();
            }
            watchers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: async (sessionId: string, options?: { treatExistingAsProcessed?: boolean }) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            // The caller explicitly re-announces this session, so give a
            // previously-dropped id another chance (its file may exist now).
            if (deadSessions.delete(sessionId)) {
                logger.debug(`[SESSION_SCANNER] Reviving previously-dropped session: ${sessionId}`);
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            // When the caller already has these messages (typical for
            // happy-reconnect — the server holds the history from prior
            // turns and metadata.claudeSessionId simply hadn't propagated
            // by the time we built the scanner), pre-mark whatever is on
            // disk so the first invalidate() does not replay the entire
            // file as fresh user prompts. Without this, every previous
            // user message re-appears in the chat after reconnect.
            if (options?.treatExistingAsProcessed) {
                const existing = await readSessionLog(projectDir, sessionId);
                logger.debug(`[SESSION_SCANNER] Pre-marking ${existing.length} existing messages as processed for new session ${sessionId}`);
                for (const m of existing) {
                    processedMessageKeys.add(messageKey(m));
                }
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
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
async function readSessionLog(projectDir: string, sessionId: string): Promise<RawJSONLines[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
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
