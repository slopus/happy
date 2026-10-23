import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { parseClaudeGoalStatusTranscriptEvent, type ClaudeGoalStatusTranscriptEvent } from "../claudeGoalStatus";
import { join } from "node:path";
import { open, stat } from "node:fs/promises";
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

export type ScannerTranscriptEvent = ClaudeGoalStatusTranscriptEvent;

type SessionLogEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent };

/**
 * Where the previous scan of a transcript stopped. Transcripts are append-only,
 * so the next scan only has to read what lies past `offset`.
 */
type TranscriptCursor = {
    dev: number;
    ino: number;
    /** Bytes of the file already read, including `tail`. */
    offset: number;
    /** Bytes after the last newline read so far: an unfinished line. */
    tail: Buffer;
};

const NEWLINE = 0x0a;

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    onTranscriptEvent?: (event: ScannerTranscriptEvent) => void
    /**
     * How long the transcript's parent directory may stay unwatchable before
     * its watcher gives up. This does not bound a late transcript file.
     */
    missingFileTimeoutMs?: number
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedEntryKeys = new Set<string>();
    // Sessions whose project directory stayed unwatchable. Their watcher gave
    // up, so do not keep re-creating it on every sync. A merely absent file is
    // watched through its parent directory and never enters this set.
    let deadSessions = new Set<string>();
    // Read position per transcript file. Owned by this scanner, not shared:
    // a process may run several scanners and each must see every line.
    let cursors = new Map<string, TranscriptCursor>();

    // Mark existing entries as processed and start watching the initial session
    if (opts.sessionId) {
        let { entries, commit } = await readSessionEntries(projectDir, opts.sessionId, cursors);
        logger.debug(`[SESSION_SCANNER] Marking ${entries.length} existing entries as processed from session ${opts.sessionId}`);
        for (let entry of entries) {
            processedEntryKeys.add(entry.key);
        }
        commit();
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
            const { entries: sessionEntries, commit } = await readSessionEntries(projectDir, session, cursors);
            let skipped = 0;
            let sentMessages = 0;
            let sentTranscriptEvents = 0;
            for (let entry of sessionEntries) {
                if (processedEntryKeys.has(entry.key)) {
                    skipped++;
                    continue;
                }
                processedEntryKeys.add(entry.key);
                if (entry.kind === 'message') {
                    logger.debug(`[SESSION_SCANNER] Sending new message: type=${entry.message.type}, uuid=${entry.message.type === 'summary' ? entry.message.leafUuid : entry.message.uuid}`);
                    opts.onMessage(entry.message);
                    sentMessages++;
                } else {
                    logger.debug(`[SESSION_SCANNER] Sending new transcript event: type=${entry.event.type}, uuid=${entry.event.uuid}`);
                    opts.onTranscriptEvent?.(entry.event);
                    sentTranscriptEvents++;
                }
            }
            // Advance only once every entry was handled, so a throwing
            // callback makes the retried sync read these lines again.
            commit();
            if (sessionEntries.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionEntries.length}, skipped=${skipped}, sentMessages=${sentMessages}, sentTranscriptEvents=${sentTranscriptEvents}`);
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
                            // The project directory stayed unwatchable. Tear
                            // down and blacklist the session so the collection
                            // loop does not resurrect the failed watcher.
                            logger.debug(`[SESSION_SCANNER] Session ${p} transcript unreachable (directory unwatchable) — dropping it`);
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
            // The final sync can create watchers, so flush and stop before
            // disposing the map. Otherwise cleanup can leak newly-created
            // directory watchers.
            await sync.invalidateAndAwait();
            sync.stop();
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
        },
        onNewSession: async (sessionId: string, options?: { treatExistingAsProcessed?: boolean }) => {
            const wasDead = deadSessions.delete(sessionId);
            if (wasDead) {
                logger.debug(`[SESSION_SCANNER] Reviving previously-dropped session: ${sessionId}`);
            }
            if (currentSessionId === sessionId) {
                if (wasDead) {
                    // A re-announced current session may have been dropped
                    // while its directory was unavailable. Do not let the
                    // same-id fast path prevent its watcher from returning.
                    sync.invalidate();
                } else {
                    logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                }
                return;
            }
            if (!wasDead && finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (!wasDead && pendingSessions.has(sessionId)) {
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
                const { entries: existing, commit } = await readSessionEntries(projectDir, sessionId, cursors);
                logger.debug(`[SESSION_SCANNER] Pre-marking ${existing.length} existing entries as processed for new session ${sessionId}`);
                for (const entry of existing) {
                    processedEntryKeys.add(entry.key);
                }
                commit();
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

function transcriptEventKey(event: ScannerTranscriptEvent): string {
    return `event:${event.uuid}`;
}

/**
 * Read and parse the lines appended to a session log file since the last
 * committed read.
 * Returns only valid conversation messages and recognized side-channel events,
 * silently skipping internal events.
 *
 * The cursor is restarted from byte 0 when the file was replaced (different
 * device/inode), shrank, or no longer has a newline where the last read ended
 * (rewritten in place). A trailing line without its newline is kept back until
 * the newline arrives. Entries before the cursor were already handed to the
 * caller, so `commit` records the new position once the caller has handled the
 * returned entries; without it the next call returns them again.
 */
async function readSessionEntries(
    projectDir: string,
    sessionId: string,
    cursors: Map<string, TranscriptCursor>,
): Promise<{ entries: SessionLogEntry[]; commit: () => void }> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    const cursor = cursors.get(expectedSessionFile);
    let data: Buffer;
    let next: TranscriptCursor;
    try {
        const probe = await stat(expectedSessionFile);
        if (cursor && probe.dev === cursor.dev && probe.ino === cursor.ino && probe.size === cursor.offset) {
            return { entries: [], commit: () => {} };
        }
        const handle = await open(expectedSessionFile, 'r');
        try {
            const { dev, ino, size } = await handle.stat();
            // Resume only if this is the same file, it has not shrunk, and the
            // last complete line still ends in a newline at the same place.
            let resumeFrom = cursor?.dev === dev && cursor.ino === ino && cursor.offset <= size ? cursor : undefined;
            const lineStart = resumeFrom ? resumeFrom.offset - resumeFrom.tail.length : 0;
            if (resumeFrom && lineStart > 0) {
                const previous = Buffer.alloc(1);
                const { bytesRead } = await handle.read(previous, 0, 1, lineStart - 1);
                if (bytesRead !== 1 || previous[0] !== NEWLINE) {
                    resumeFrom = undefined;
                }
            }
            const start = resumeFrom?.offset ?? 0;
            const fresh = Buffer.alloc(size - start);
            let filled = 0;
            while (filled < fresh.length) {
                const { bytesRead } = await handle.read(fresh, filled, fresh.length - filled, start + filled);
                if (bytesRead === 0) {
                    break;
                }
                filled += bytesRead;
            }
            data = resumeFrom && resumeFrom.tail.length > 0
                ? Buffer.concat([resumeFrom.tail, fresh.subarray(0, filled)])
                : fresh.subarray(0, filled);
            next = { dev, ino, offset: start + filled, tail: Buffer.alloc(0) };
        } finally {
            await handle.close();
        }
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return { entries: [], commit: () => {} };
    }
    // Splitting on the newline byte cannot cut a multi-byte UTF-8 character,
    // so the complete lines decode cleanly and the unfinished one waits.
    const completeEnd = data.lastIndexOf(NEWLINE) + 1;
    next.tail = Buffer.from(data.subarray(completeEnd));
    let lines = data.toString('utf-8', 0, completeEnd).split('\n');
    let entries: SessionLogEntry[] = [];
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

            const transcriptEvent = parseClaudeGoalStatusTranscriptEvent(message);
            if (transcriptEvent) {
                entries.push({
                    kind: 'transcript-event',
                    key: transcriptEventKey(transcriptEvent),
                    event: transcriptEvent,
                });
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped
                continue;
            }
            entries.push({
                kind: 'message',
                key: messageKey(parsed.data),
                message: parsed.data,
            });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return { entries, commit: () => { cursors.set(expectedSessionFile, next); } };
}
