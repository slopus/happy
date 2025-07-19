import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { resolve } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";

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

        // Process sessions
        for (let session of sessions) {
            const expectedSessionFile = join(projectDir, `${session}.jsonl`);
            let file: string;
            try {
                file = await readFile(expectedSessionFile, 'utf-8');
            } catch (error) {
                continue;
            }
            let lines = file.split('\n');
            for (let l of lines) {
                try {
                    let message = JSON.parse(l);
                    let parsed = RawJSONLinesSchema.safeParse(message);
                    if (!parsed.success) {
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

        // Move pending sessions to finished sessions
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }
    });

    // Periodic sync
    setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        refresh: () => sync.invalidate(),
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
        // For user messages: timestamp + content
        // Timestamp is stable across resumes
        const content = typeof message.message.content === 'string'
            ? message.message.content
            : JSON.stringify(message.message.content)
        return `user:${message.timestamp}:${content}`
    } else if (message.type === 'assistant') {
        // For assistant messages: use content for deduplication
        // This handles cases where the same message.id has different content
        // (e.g., text response followed by tool_use)
        const content = JSON.stringify(message.message.content)
        return `assistant:${message.message.id}:${content}`
    } else if (message.type === 'summary') {
        return `summary:${message.leafUuid}`
    } else if (message.type === 'system') {
        return `system:${message.content}`
    }

    return `unknown:<error, this should be unreachable>`
}
