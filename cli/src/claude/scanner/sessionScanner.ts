import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { resolve } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, watch } from "node:fs/promises";
import { logger } from "@/ui/logger";

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
    let currentSessionWatcherAbortController: AbortController | null = null;
    let processedMessages = new Set<string>();

    // Main sync function
    const sync = new InvalidateSync(async () => {

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
                return;
            }
            let lines = file.split('\n');
            for (let l of lines) {
                try {
                    let message = JSON.parse(l);
                    let parsed = RawJSONLinesSchema.safeParse(message);
                    if (!parsed.success) {
                        logger.debugLargeJson(`[SESSION_SCANNER] Failed to parse message`, message)
                        continue;
                    }

                    // Hash
                    let key = getMessageKey(parsed.data);
                    if (processedMessages.has(key)) {
                        continue;
                    }
                    processedMessages.add(key);

                    // Notify
                    opts.onMessage(parsed.data);
                } catch (e) {
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

        // Invalidate old watcher & start new one
        currentSessionWatcherAbortController?.abort();
        currentSessionWatcherAbortController = new AbortController();
        void (async () => {
            if (currentSessionId) {
                const sessionFile = join(projectDir, `${currentSessionId}.jsonl`);
                try {
                    for await (const change of watch(sessionFile, { persistent: true, signal: currentSessionWatcherAbortController.signal })) {
                        await processSessionFile(currentSessionId);
                    }
                } catch (error: any) {
                    if (error.name !== 'AbortError') {
                        logger.debug(`[SESSION_SCANNER] Watch error: ${error.message}`);
                    }
                }
            }
        })();

        // We do not want to be creating a new watcher 
    });

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        refresh: () => sync.invalidate(),
        cleanup: () => {
            clearInterval(intervalId);
            currentSessionWatcherAbortController?.abort();
        },
        onNewSession: (sessionId: string) => {
            if (currentSessionId === sessionId) {
                return;
            }
            if (finishedSessions.has(sessionId)) {
                return;
            }
            if (pendingSessions.has(sessionId)) {
                return;
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

function getMessageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return `user:${message.uuid}`
    } else if (message.type === 'assistant') {
        return `assistant:${message.uuid}`
    } else if (message.type === 'summary') {
        return `summary:${message.leafUuid}`
    } else if (message.type === 'system') {
        return `system:${message.uuid}`
    }

    return `unknown:<error, this should be unreachable>`
}
