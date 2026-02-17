import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RawJSONLines, RawJSONLinesSchema } from '@/claude/types';
import { getProjectPath } from './path';
import { logger } from '@/ui/logger';

const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    }
    if (message.type === 'assistant') {
        return message.uuid;
    }
    if (message.type === 'summary') {
        return `summary:${message.leafUuid}`;
    }
    if (message.type === 'system') {
        return message.uuid;
    }
    if (message.type === 'progress') {
        return message.uuid;
    }
    return `unknown:${Math.random()}`;
}

function isPrimaryUserMessage(message: RawJSONLines): boolean {
    if (message.type !== 'user') return false;
    if ((message as any).isSidechain) return false;
    if ((message as any).isMeta) return false;
    // Tool results have content as array with tool_result type, not real user input
    const content = (message as any).message?.content;
    if (Array.isArray(content)) return false;
    if (typeof content === 'string') {
        const text = content.trim();
        if (text.startsWith('<task-notification>') && text.includes('</task-notification>')) {
            return false;
        }
    }
    return true;
}

async function readSessionLog(projectDir: string, sessionId: string): Promise<RawJSONLines[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[BACKFILL] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch (error) {
        logger.debug(`[BACKFILL] Session file not found: ${expectedSessionFile}`);
        return [];
    }

    const lines = file.split('\n');
    const messages: RawJSONLines[] = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const parsedLine = JSON.parse(line);
            if (parsedLine?.type && INTERNAL_CLAUDE_EVENT_TYPES.has(parsedLine.type)) {
                continue;
            }
            const parsed = RawJSONLinesSchema.safeParse(parsedLine);
            if (!parsed.success) {
                continue;
            }
            messages.push(parsed.data);
        } catch (error) {
            logger.debug('[BACKFILL] Failed to parse session line', { error });
        }
    }
    return messages;
}

export async function backfillClaudeSessionHistory(opts: {
    workingDirectory: string;
    sessionId: string;
    send?: (message: RawJSONLines, localId?: string) => void;
    sendBatch?: (messages: { message: RawJSONLines; localId: string }[]) => void | Promise<void>;
    maxMessages?: number;
    maxUserMessages?: number;
    maxBytes?: number;
}) {
    const maxMessages = opts.maxMessages ?? 200;
    const maxUserMessages = opts.maxUserMessages ?? 20;
    const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;

    const projectDir = getProjectPath(opts.workingDirectory);
    let messages = await readSessionLog(projectDir, opts.sessionId);

    // Fallback: if resolve() path doesn't match Claude's projectId (e.g., symlinks), try raw path.
    if (!messages.length) {
        const rawProjectId = opts.workingDirectory.replace(/[\\\/\.: _]/g, '-');
        const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
        const rawProjectDir = join(claudeConfigDir, 'projects', rawProjectId);
        if (rawProjectDir !== projectDir) {
            messages = await readSessionLog(rawProjectDir, opts.sessionId);
        }
    }

    if (!messages.length) {
        logger.debug('[BACKFILL] No messages to backfill');
        return;
    }

    const selected: RawJSONLines[] = [];
    let totalCount = 0;
    let userCount = 0;
    let totalBytes = 0;

    // Work backwards from the most recent message
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.type === 'summary') {
            continue; // Skip summaries to avoid title churn
        }
        const estimatedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (totalBytes + estimatedBytes > maxBytes) {
            if (selected.length === 0) {
                selected.push(message);
                totalBytes += estimatedBytes;
            }
            break;
        }
        selected.push(message);
        totalBytes += estimatedBytes;

        // Progress messages are included but don't count toward limits
        if (message.type === 'progress') {
            continue;
        }

        totalCount += 1;
        const isPrimaryUser = isPrimaryUserMessage(message);
        if (isPrimaryUser) {
            userCount += 1;
        }

        // Stop when we reach the user-message limit (always on a user message),
        // or when we reach the max message limit *and* the current message is a user.
        // This ensures the oldest restored message is a user message even if we exceed maxMessages.
        if (userCount >= maxUserMessages) {
            break;
        }
        if (totalCount >= maxMessages && isPrimaryUser) {
            break;
        }
    }

    selected.reverse();
    logger.debug(`[BACKFILL] Backfilling ${selected.length} messages (users: ${userCount}, total: ${totalCount}, bytes: ${totalBytes})`);

    const batch = selected.map((message) => ({
        message,
        localId: `claude-log:${opts.sessionId}:${messageKey(message)}`
    }));

    if (opts.sendBatch) {
        await opts.sendBatch(batch);
        return;
    }

    if (opts.send) {
        for (const item of batch) {
            opts.send(item.message, item.localId);
        }
    }
}
