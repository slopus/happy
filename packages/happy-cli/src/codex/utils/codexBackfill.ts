/**
 * Codex Session Backfill
 *
 * Reads a Codex JSONL session file and sends historical messages
 * to the Happy app via message-batch, so the mobile UI shows
 * conversation history when a session is resumed or copied.
 */

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { logger } from '@/ui/logger';
import {
    findCodexSessionFile,
    extractUserText,
    isSystemMessage,
    generateStableUuid,
} from './codexSessionReader';

export interface CodexBackfillOptions {
    /**
     * Codex session identifier — can be either:
     * - An absolute file path (from fork/duplicate, e.g. /home/user/.codex/sessions/.../rollout-xxx.jsonl)
     * - A session ID (matched via findCodexSessionFile)
     */
    sessionIdOrPath: string;
    /** Send the batch to the app */
    sendBatch: (messages: { content: unknown; localId: string }[]) => Promise<void>;
    /** Max total messages to include (default: 200) */
    maxMessages?: number;
    /** Max user messages to include (default: 20) */
    maxUserMessages?: number;
    /** Max total bytes (default: 3 MB) */
    maxBytes?: number;
}

/**
 * Extract assistant text from a Codex response_item payload.
 */
function extractAssistantText(payload: any): string | null {
    const content = payload?.content;
    if (!content) return null;

    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
            if (block?.type === 'output_text' && typeof block.text === 'string') {
                texts.push(block.text);
            }
        }
        return texts.join('\n') || null;
    }

    return null;
}

interface ParsedCodexMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
    index: number;
    estimatedBytes: number;
}

function buildMessageContent(msg: ParsedCodexMessage): unknown {
    if (msg.role === 'user') {
        return {
            role: 'user',
            content: { type: 'text', text: msg.text },
            meta: { sentFrom: 'cli' },
        };
    }
    return {
        role: 'agent',
        content: {
            type: 'acp',
            provider: 'codex',
            data: { type: 'message', message: msg.text },
        },
        meta: { sentFrom: 'cli' },
    };
}

/**
 * Resolve sessionIdOrPath to an absolute file path.
 * If it looks like a file path (contains / and ends with .jsonl), use directly.
 * Otherwise treat as a session ID and search via findCodexSessionFile.
 */
function resolveCodexSessionFile(sessionIdOrPath: string): string | null {
    // Fork/duplicate passes an absolute file path; resume-by-id passes a session ID
    if (isAbsolute(sessionIdOrPath)) {
        return sessionIdOrPath;
    }
    return findCodexSessionFile(sessionIdOrPath);
}

export async function backfillCodexSessionHistory(opts: CodexBackfillOptions): Promise<void> {
    const maxMessages = opts.maxMessages ?? 200;
    const maxUserMessages = opts.maxUserMessages ?? 20;
    const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;

    const filePath = resolveCodexSessionFile(opts.sessionIdOrPath);
    if (!filePath) {
        logger.debug(`[CODEX-BACKFILL] Session file not found for: ${opts.sessionIdOrPath}`);
        return;
    }

    let content: string;
    try {
        content = await readFile(filePath, 'utf-8');
    } catch (error) {
        logger.debug(`[CODEX-BACKFILL] Failed to read file: ${filePath}`, error);
        return;
    }

    const lines = content.split('\n');
    const allMessages: ParsedCodexMessage[] = [];
    let msgIndex = 0;

    for (const line of lines) {
        if (!line.trim()) continue;

        let parsed: any;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        if (parsed.type !== 'response_item') continue;

        const payload = parsed.payload;
        const timestamp = parsed.timestamp || '';

        if (payload?.role === 'user') {
            const text = extractUserText(payload);
            if (!text || isSystemMessage(text)) continue;

            allMessages.push({
                role: 'user',
                text,
                timestamp,
                index: msgIndex++,
                estimatedBytes: Buffer.byteLength(text, 'utf8'),
            });
        } else if (payload?.role === 'assistant') {
            const text = extractAssistantText(payload);
            if (!text) continue;

            allMessages.push({
                role: 'assistant',
                text,
                timestamp,
                index: msgIndex++,
                estimatedBytes: Buffer.byteLength(text, 'utf8'),
            });
        }
    }

    if (allMessages.length === 0) {
        logger.debug('[CODEX-BACKFILL] No messages to backfill');
        return;
    }

    // Select from the end, respecting limits
    const selected: ParsedCodexMessage[] = [];
    let totalCount = 0;
    let userCount = 0;
    let totalBytes = 0;

    for (let i = allMessages.length - 1; i >= 0; i--) {
        const msg = allMessages[i];
        if (totalBytes + msg.estimatedBytes > maxBytes && selected.length > 0) break;

        selected.push(msg);
        totalBytes += msg.estimatedBytes;
        totalCount++;

        if (msg.role === 'user') {
            userCount++;
        }

        if (userCount >= maxUserMessages) break;
        if (totalCount >= maxMessages && msg.role === 'user') break;
    }

    selected.reverse();

    // Use filename as stable key for localId deduplication
    const fileKey = basename(filePath, '.jsonl');
    logger.debug(`[CODEX-BACKFILL] Backfilling ${selected.length} messages (users: ${userCount}, total: ${totalCount}, bytes: ${totalBytes})`);

    const batch = selected.map((msg) => ({
        content: buildMessageContent(msg),
        localId: `codex-log:${fileKey}:${generateStableUuid(msg.timestamp, msg.index)}`,
    }));

    await opts.sendBatch(batch);
}
