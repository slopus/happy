/**
 * Gemini Session Backfill
 *
 * Reads a Gemini JSONL session file and sends historical messages
 * to the Happy app via message-batch, so the mobile UI shows
 * conversation history when a session is resumed or copied.
 */

import { logger } from '@/ui/logger';
import { readGeminiSessionLog } from './sessionReader';
import type { GeminiSessionLine } from './sessionTypes';
import { summarizeBashToolOutput } from '@/modules/common/loadableToolOutput';

export interface GeminiBackfillOptions {
    /** Gemini session ID (used to locate the JSONL file) */
    sessionId: string;
    /** Send the batch to the app */
    sendBatch: (messages: { content: unknown; localId: string }[]) => Promise<void>;
    /** Max total messages to include (default: 200) */
    maxMessages?: number;
    /** Max user messages to include (default: 20) */
    maxUserMessages?: number;
    /** Max total bytes (default: 3 MB) */
    maxBytes?: number;
}

type ConversationLine = Extract<GeminiSessionLine, { type: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'file-edit' }>;

function isConversationLine(line: GeminiSessionLine): line is ConversationLine {
    return line.type === 'user' || line.type === 'assistant'
        || line.type === 'tool-call' || line.type === 'tool-result'
        || line.type === 'file-edit';
}

function buildMessageContent(line: ConversationLine, callIdToName: Map<string, string>): unknown {
    if (line.type === 'user') {
        return {
            role: 'user',
            content: { type: 'text', text: line.message },
            meta: { sentFrom: 'cli' },
        };
    }

    if (line.type === 'assistant') {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'gemini',
                data: { type: 'message', message: line.message },
            },
            meta: { sentFrom: 'cli' },
        };
    }

    if (line.type === 'tool-call') {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'gemini',
                data: {
                    type: 'tool-call',
                    callId: line.callId,
                    name: line.name,
                    input: line.input,
                    id: line.uuid,
                },
            },
            meta: { sentFrom: 'cli' },
        };
    }

    if (line.type === 'tool-result') {
        // Trim heavy payloads (same as real-time sending in runGemini)
        const toolName = callIdToName.get(line.callId);
        let output: unknown = line.output;

        // GeminiBash: only send exit_code (matches real-time behaviour)
        if (toolName === 'GeminiBash' && typeof output === 'object' && output !== null) {
            output = summarizeBashToolOutput({
                sessionId: 'gemini-backfill',
                callId: line.callId,
                toolName: 'GeminiBash',
                agent: 'gemini',
                result: output,
                persist: false,
            });
        } else if (typeof output === 'string' && output.length > 500) {
            output = output.substring(0, 500) + '... [truncated]';
        } else if (typeof output === 'object' && output !== null) {
            const serialized = JSON.stringify(output);
            if (serialized.length > 500) {
                output = serialized.substring(0, 500) + '... [truncated]';
            }
        }

        return {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'gemini',
                data: {
                    type: 'tool-result',
                    callId: line.callId,
                    output,
                    id: line.uuid,
                    isError: line.isError,
                },
            },
            meta: { sentFrom: 'cli' },
        };
    }

    // file-edit — don't send diff content (same as real-time sending)
    if (line.type === 'file-edit') {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'gemini',
                data: {
                    type: 'file-edit',
                    filePath: line.filePath,
                    description: line.description,
                    id: line.uuid,
                },
            },
            meta: { sentFrom: 'cli' },
        };
    }

    // Should not reach here
    return null;
}

function estimateBytes(line: ConversationLine): number {
    if (line.type === 'user' || line.type === 'assistant') {
        return Buffer.byteLength(line.message, 'utf8');
    }
    if (line.type === 'tool-result') {
        // After trimming, output is capped at ~500 chars
        const raw = typeof line.output === 'string' ? line.output : JSON.stringify(line.output);
        return Math.min(Buffer.byteLength(raw, 'utf8'), 600);
    }
    if (line.type === 'tool-call') {
        const inputStr = typeof line.input === 'string' ? line.input : JSON.stringify(line.input ?? '');
        return Buffer.byteLength(line.name, 'utf8') + Math.min(Buffer.byteLength(inputStr, 'utf8'), 1000);
    }
    // file-edit — diff stripped, only description + path
    if (line.type === 'file-edit') {
        return Buffer.byteLength(line.description, 'utf8') + Buffer.byteLength(line.filePath, 'utf8');
    }
    return 200;
}

export async function backfillGeminiSessionHistory(opts: GeminiBackfillOptions): Promise<void> {
    const maxMessages = opts.maxMessages ?? 200;
    const maxUserMessages = opts.maxUserMessages ?? 20;
    const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;

    const allLines = await readGeminiSessionLog(opts.sessionId);
    const conversationLines = allLines.filter(isConversationLine);

    if (conversationLines.length === 0) {
        logger.debug('[GEMINI-BACKFILL] No messages to backfill');
        return;
    }

    // Select from the end, respecting limits
    const selected: ConversationLine[] = [];
    let totalCount = 0;
    let userCount = 0;
    let totalBytes = 0;

    for (let i = conversationLines.length - 1; i >= 0; i--) {
        const line = conversationLines[i];
        const bytes = estimateBytes(line);
        if (totalBytes + bytes > maxBytes && selected.length > 0) break;

        selected.push(line);
        totalBytes += bytes;
        totalCount++;

        if (line.type === 'user') {
            userCount++;
        }

        if (userCount >= maxUserMessages) break;
        if (totalCount >= maxMessages && line.type === 'user') break;
    }

    selected.reverse();

    // Build callId → toolName map for trimming tool results (e.g. GeminiBash → exit_code only)
    const callIdToName = new Map<string, string>();
    for (const line of conversationLines) {
        if (line.type === 'tool-call') {
            callIdToName.set(line.callId, line.name);
        }
    }

    logger.debug(`[GEMINI-BACKFILL] Backfilling ${selected.length} messages (users: ${userCount}, total: ${totalCount}, bytes: ${totalBytes})`);

    const batch: { content: unknown; localId: string }[] = [];
    for (const line of selected) {
        const content = buildMessageContent(line, callIdToName);
        if (!content) continue;

        batch.push({
            content,
            localId: `gemini-log:${opts.sessionId}:${line.uuid}`,
        });
    }

    await opts.sendBatch(batch);
}
