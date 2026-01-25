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
    return `unknown:${Math.random()}`;
}

function isPrimaryUserMessage(message: RawJSONLines): boolean {
    if (message.type !== 'user') return false;
    if ((message as any).isSidechain) return false;
    if ((message as any).isMeta) return false;
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
    send: (message: RawJSONLines, localId?: string) => void;
    maxMessages?: number;
    maxUserMessages?: number;
}) {
    const maxMessages = opts.maxMessages ?? 200;
    const maxUserMessages = opts.maxUserMessages ?? 20;

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

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.type === 'summary') {
            continue; // Skip summaries to avoid title churn
        }
        selected.push(message);
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
    logger.debug(`[BACKFILL] Backfilling ${selected.length} messages (users: ${userCount}, total: ${totalCount})`);

    for (const message of selected) {
        const localId = `claude-log:${opts.sessionId}:${messageKey(message)}`;
        opts.send(message, localId);
    }
}
