import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { parseClaudeGoalStatusTranscriptEvent, type ClaudeGoalStatusTranscriptEvent } from "../claudeGoalStatus";
import { basename, dirname, join, resolve } from "node:path";
import { access, readdir, readFile, stat } from "node:fs/promises";
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

const CLAUDE_SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export type ScannerTranscriptEvent = ClaudeGoalStatusTranscriptEvent;
export type TranscriptRecoveryResult =
    | { type: 'recovered'; sessionId: string; reason: 'hook-transcript-path' }
    | { type: 'none' }
    | { type: 'ambiguous'; candidates: string[] };

type SessionLogEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent };

type WatcherInfo = {
    stop: () => void;
    baselineSessionIds: Set<string>;
};

type NewSessionOptions = {
    treatExistingAsProcessed?: boolean;
    transcriptPath?: string;
};

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    onTranscriptEvent?: (event: ScannerTranscriptEvent) => void
    /**
     * How long a session transcript may stay absent before its watcher gives
     * up and the session is dropped. Defaults to the startFileWatcher default
     * (60s). Exposed mainly so tests can exercise the drop path quickly.
     */
    missingFileTimeoutMs?: number
    /**
     * Passed through to startFileWatcher. Tests lower this so phantom
     * transcript recovery and give-up behavior can run quickly.
     */
    watcherInitialRetryDelayMs?: number
    watcherMaxRetryDelayMs?: number
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, WatcherInfo>();
    let processedEntryKeys = new Set<string>();
    let explicitTranscriptPaths = new Map<string, string>();
    let scannerStopped = false;
    // Sessions whose transcript file never appeared. Their watcher gave up,
    // so we must stop re-reading them and never re-create a watcher for them
    // — otherwise a phantom session id (e.g. a remote launch whose .jsonl is
    // never written) keeps itself alive forever via the watchers map below
    // and spins the CPU / floods the log (the "dead Happy instance" bug).
    let deadSessions = new Set<string>();

    const initialKnownSessionIds = await listValidSessionIds(projectDir);

    // Mark existing entries as processed and start watching the initial session
    if (opts.sessionId) {
        let entries = await readSessionEntries(projectDir, opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${entries.length} existing entries as processed from session ${opts.sessionId}`);
        for (let entry of entries) {
            processedEntryKeys.add(entry.key);
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {
        if (scannerStopped) {
            return;
        }

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
            const sessionEntries = await readSessionEntries(projectDir, session);
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
                watchers.set(p, {
                    baselineSessionIds: new Set(initialKnownSessionIds),
                    stop: startFileWatcher(
                        join(projectDir, `${p}.jsonl`),
                        () => { sync.invalidate(); },
                        {
                            missingFileTimeoutMs: opts.missingFileTimeoutMs,
                            initialRetryDelayMs: opts.watcherInitialRetryDelayMs,
                            maxRetryDelayMs: opts.watcherMaxRetryDelayMs,
                            onGaveUp: () => {
                                void handleMissingSession(p);
                            },
                        },
                    ),
                });
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    const scannerApi = {
        cleanup: async () => {
            scannerStopped = true;
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w.stop();
            }
            watchers.clear();
            sync.stop();
        },
        onNewSession: async (sessionId: string, options?: NewSessionOptions) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                if (options?.transcriptPath) {
                    explicitTranscriptPaths.set(sessionId, options.transcriptPath);
                }
                return;
            }
            if (options?.transcriptPath) {
                explicitTranscriptPaths.set(sessionId, options.transcriptPath);
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
                const existing = await readSessionEntries(projectDir, sessionId);
                logger.debug(`[SESSION_SCANNER] Pre-marking ${existing.length} existing entries as processed for new session ${sessionId}`);
                for (const entry of existing) {
                    processedEntryKeys.add(entry.key);
                }
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    };

    return scannerApi;

    async function handleMissingSession(sessionId: string) {
        if (scannerStopped) {
            return;
        }

        const recovery = await recoverMissingSession({
            missingSessionId: sessionId,
            projectDir,
            baselineSessionIds: watchers.get(sessionId)?.baselineSessionIds ?? new Set(initialKnownSessionIds),
            explicitTranscriptPath: explicitTranscriptPaths.get(sessionId),
        });
        if (scannerStopped) {
            return;
        }
        if (recovery.type === 'recovered') {
            logger.debug(`[SESSION_SCANNER] Recovered missing session ${sessionId} as ${recovery.sessionId} via ${recovery.reason}`);
            dropSession(sessionId);
            void scannerApi.onNewSession(recovery.sessionId, { treatExistingAsProcessed: false });
            return;
        }

        if (recovery.type === 'ambiguous') {
            logger.debug(`[SESSION_SCANNER] Session ${sessionId} transcript never appeared; not recovering because candidates are ambiguous: ${recovery.candidates.join(', ')}`);
        } else {
            logger.debug(`[SESSION_SCANNER] Session ${sessionId} transcript never appeared — dropping it`);
        }
        dropSession(sessionId);
    }

    function dropSession(sessionId: string) {
        const watcher = watchers.get(sessionId);
        watcher?.stop();
        watchers.delete(sessionId);
        deadSessions.add(sessionId);
        pendingSessions.delete(sessionId);
        explicitTranscriptPaths.delete(sessionId);
        if (currentSessionId === sessionId) {
            currentSessionId = null;
        }
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
 * Read and parse session log file
 * Returns only valid conversation messages and recognized side-channel events,
 * silently skipping internal events.
 */
async function readSessionEntries(projectDir: string, sessionId: string): Promise<SessionLogEntry[]> {
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
    return entries;
}

export async function recoverMissingSession(opts: {
    missingSessionId: string;
    projectDir: string;
    baselineSessionIds: Set<string>;
    explicitTranscriptPath?: string;
}): Promise<TranscriptRecoveryResult> {
    const explicitSessionId = await resolveExplicitTranscriptSession(opts.projectDir, opts.explicitTranscriptPath);
    if (explicitSessionId && explicitSessionId !== opts.missingSessionId) {
        return { type: 'recovered', sessionId: explicitSessionId, reason: 'hook-transcript-path' };
    }

    const currentSessionIds = await listValidSessionIds(opts.projectDir);
    const candidates = [...currentSessionIds]
        .filter((sessionId) => sessionId !== opts.missingSessionId)
        .filter((sessionId) => !opts.baselineSessionIds.has(sessionId))
        .sort();

    if (candidates.length === 0) {
        return { type: 'none' };
    }
    return { type: 'ambiguous', candidates };
}

async function resolveExplicitTranscriptSession(projectDir: string, transcriptPath: string | undefined): Promise<string | null> {
    if (!transcriptPath) {
        return null;
    }
    if (resolve(dirname(transcriptPath)) !== resolve(projectDir)) {
        logger.debug(`[SESSION_SCANNER] Ignoring transcript_path outside project dir: ${transcriptPath}`);
        return null;
    }
    const filename = basename(transcriptPath);
    if (!CLAUDE_SESSION_FILE_RE.test(filename)) {
        logger.debug(`[SESSION_SCANNER] Ignoring non-session transcript_path: ${transcriptPath}`);
        return null;
    }

    const sessionId = filename.slice(0, -'.jsonl'.length);
    try {
        await access(transcriptPath);
    } catch {
        return null;
    }
    const entries = await readSessionEntries(projectDir, sessionId);
    return entries.length > 0 ? sessionId : null;
}

async function listValidSessionIds(projectDir: string): Promise<Set<string>> {
    let files: string[];
    try {
        files = await readdir(projectDir);
    } catch {
        return new Set();
    }

    const sessionIds = await Promise.all(files
        .filter((file) => CLAUDE_SESSION_FILE_RE.test(file))
        .map(async (file) => {
            const sessionId = file.slice(0, -'.jsonl'.length);
            try {
                const fileStat = await stat(join(projectDir, file));
                if (!fileStat.isFile()) {
                    return null;
                }
                const entries = await readSessionEntries(projectDir, sessionId);
                return entries.length > 0 ? sessionId : null;
            } catch {
                return null;
            }
        }));

    return new Set(sessionIds.filter((sessionId): sessionId is string => sessionId !== null));
}
