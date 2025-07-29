import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { resolve } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";

export function createSessionScanner(opts: {
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
}) {

    // Resolve project directory
    const projectName = resolve(opts.workingDirectory).replace(/\//g, '-')
    const projectDir = join(homedir(), '.claude', 'projects', projectName)

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedMessages = new Set<string>();

    /*
        NOTE: User messages that come to us from the remote session, will be
        written by claude to session file, and re-emitted to us.
        We cannot pass any stable ID to claude for the message.

        Invariant:
        For each incoming user message, we expect to see it come out of the session
        scanner exactly once.

        Why can't we simply ignore messages with the same content we have seen?
        - Remote User: Run 'yarn build'
        - Scanner emits 'user: Run 'yarn build''
        - [switch to local mode]
        - Local user (through claude terminal session): Run 'yarn build'
        - Scanner emits 'user: Run 'yarn build''
        
        So if we were to ignore messages with the same content we have seen, we would not emit this message to the server. The counter solution addresses this.
    */
    let seenRemoteUserMessageCounters: Map<string, number> = new Map();

    // Main sync function
    const sync = new InvalidateSync(async () => {
        logger.debug(`[SESSION_SCANNER] Syncing...`);

        // Collect session ids
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            sessions.push(p);
        }
        if (currentSessionId) {
            sessions.push(currentSessionId);
        }

        let processSessionFile = async (sessionId: string) => {
            const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
            let file: string;
            try {
                // NOTE: When running claude in remote mode, we might not have
                // the session file yet.
                // We will fix it later with a session file watcher on claude side.
                file = await readFile(expectedSessionFile, 'utf-8');
            } catch (error) {
                logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
                return;
            }
            let lines = file.split('\n');
            for (let l of lines) {
                try {
                    let message = JSON.parse(l);
                    let parsed = RawJSONLinesSchema.safeParse(message);
                    if (!parsed.success) { // We can't deduplicate this message so we have to skip it
                        logger.debugLargeJson(`[SESSION_SCANNER] Failed to parse message`, message)
                        continue;
                    }

                    // Hash
                    let key = getMessageKey(parsed.data);
                    if (processedMessages.has(key)) {
                        continue;
                    }
                    processedMessages.add(key);

                    logger.debugLargeJson(`[SESSION_SCANNER] Processing message`, parsed.data)
                    logger.debug(`[SESSION_SCANNER] Message key (new): ${key}`)

                    // Check if this is a user message that should be deduplicated
                    if (parsed.data.type === 'user' && typeof parsed.data.message.content === 'string' && parsed.data.isSidechain !== true && parsed.data.isMeta !== true) {
                        const currentCounter = seenRemoteUserMessageCounters.get(parsed.data.message.content);
                        if (currentCounter && currentCounter > 0) {
                            // We have already seen this message from the remote session
                            // Lets decrement the counter & skip
                            seenRemoteUserMessageCounters.set(parsed.data.message.content, currentCounter - 1);
                            continue;
                        }
                    }

                    // Notify
                    opts.onMessage(message); // Send original message to the server
                } catch (e) {
                    logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
                    continue;
                }
            }
        }

        // Process sessions
        for (let session of sessions) {
            await processSessionFile(session);
        }

        // Move pending sessions to finished sessions
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers
        for (let p of sessions) {
            if (!watchers.has(p)) {
                watchers.set(p, startFileWatcher(join(projectDir, `${p}.jsonl`), () => {
                    sync.invalidate();
                }));
            }
        }
    });
    sync.invalidate();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: () => {
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
        },
        onNewSession: (sessionId: string) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
        onRemoteUserMessageForDeduplication: (messageContent: string) => {
            // Increment the counter for this remote user message
            seenRemoteUserMessageCounters.set(messageContent, (seenRemoteUserMessageCounters.get(messageContent) || 0) + 1);
        },
    }
}

function getMessageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return `user:${message.uuid}`
    } else if (message.type === 'assistant') {
        // Usage will sometimes change, but otherwise the message will be 
        // exactly the same
        const { usage, ...messageWithoutUsage } = message.message;

        // @kirill has observed strange cases where the same assistant message
        // is duplicated in the history, with the same content, but new uuid
        return stableStringify(messageWithoutUsage)
    } else if (message.type === 'summary') {
        return `summary:${message.leafUuid}`
    } else if (message.type === 'system') {
        return `system:${message.uuid}`
    }

    return `unknown:<error, this should be unreachable>`
}

function stableStringify(obj: any): string {
    return JSON.stringify(sortKeys(obj), null, 2);
}

function sortKeys(value: any): any {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    } else if (value && typeof value === 'object' && value.constructor === Object) {
        return Object.keys(value).sort().reduce((result: any, key) => {
            result[key] = sortKeys(value[key]);
            return result;
        }, {});
    } else {
        return value;
    }
}
