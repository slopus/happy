import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Dirent } from 'node:fs';

export interface ClaudeSessionIndexEntry {
    sessionId: string;
    projectId: string;
    originalPath: string | null;
    title?: string | null;
    updatedAt?: number;
    messageCount?: number;
    gitBranch?: string | null;
}

type ParsedSession = {
    sessionId: string;
    updatedAt?: number;
    title?: string | null;
    messageCount?: number;
    gitBranch?: string | null;
};

function parseTimestamp(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
        const asNumber = Number(value);
        if (Number.isFinite(asNumber)) {
            return asNumber;
        }
    }
    return undefined;
}

function extractSessionId(entry: any): string | null {
    if (!entry || typeof entry !== 'object') return null;
    const candidates = [entry.sessionId, entry.id, entry.uuid, entry.sid];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return null;
}

function extractUpdatedAt(entry: any): number | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    const candidates = [
        entry.updatedAt,
        entry.lastUpdatedAt,
        entry.lastMessageAt,
        entry.lastMessageTime,
        entry.modifiedAt,
        entry.modified,
        entry.mtime,
        entry.fileMtime,
        entry.createdAt,
        entry.created,
        entry.timestamp
    ];
    for (const candidate of candidates) {
        const parsed = parseTimestamp(candidate);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
}

function extractTitle(entry: any): string | null {
    if (!entry || typeof entry !== 'object') return null;
    const candidates = [entry.title, entry.summary, entry.firstPrompt, entry.prompt];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return null;
}

function extractMessageCount(entry: any): number | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    if (typeof entry.messageCount === 'number' && entry.messageCount >= 0) {
        return entry.messageCount;
    }
    return undefined;
}

function extractGitBranch(entry: any): string | null {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.gitBranch === 'string' && entry.gitBranch.trim()) {
        return entry.gitBranch.trim();
    }
    return null;
}

/**
 * Quickly count user messages in a JSONL file by scanning for "type":"user" patterns
 * This is much faster than parsing every line as JSON
 */
async function countMessagesInJsonl(jsonlPath: string): Promise<number> {
    try {
        const content = await readFile(jsonlPath, 'utf8');
        // Count lines that contain "type":"user" - these are user messages
        const matches = content.match(/"type"\s*:\s*"user"/g);
        return matches ? matches.length : 0;
    } catch {
        return 0;
    }
}

function extractSessionsFromIndex(data: any): ParsedSession[] {
    if (!data) return [];

    // Common Claude index shape: { entries: [...] }
    if (Array.isArray(data.entries)) {
        const sessions: ParsedSession[] = [];
        for (const entry of data.entries) {
            const sessionId = extractSessionId(entry);
            if (!sessionId) continue;
            sessions.push({
                sessionId,
                updatedAt: extractUpdatedAt(entry),
                title: extractTitle(entry),
                messageCount: extractMessageCount(entry),
                gitBranch: extractGitBranch(entry)
            });
        }
        return sessions;
    }

    // Common shape: { sessions: [...] }
    if (Array.isArray(data.sessions)) {
        const sessions: ParsedSession[] = [];
        for (const entry of data.sessions) {
            const sessionId = extractSessionId(entry);
            if (!sessionId) continue;
            sessions.push({
                sessionId,
                updatedAt: extractUpdatedAt(entry),
                title: extractTitle(entry),
                messageCount: extractMessageCount(entry),
                gitBranch: extractGitBranch(entry)
            });
        }
        return sessions;
    }

    // Common shape: { sessions: { [id]: {...} } }
    if (data.sessions && typeof data.sessions === 'object') {
        const sessions: ParsedSession[] = [];
        for (const [sessionId, entry] of Object.entries(data.sessions)) {
            if (typeof sessionId !== 'string' || !sessionId.trim()) continue;
            sessions.push({
                sessionId: sessionId.trim(),
                updatedAt: extractUpdatedAt(entry),
                title: extractTitle(entry),
                messageCount: extractMessageCount(entry),
                gitBranch: extractGitBranch(entry)
            });
        }
        return sessions;
    }

    // Fallback: array at root
    if (Array.isArray(data)) {
        const sessions: ParsedSession[] = [];
        for (const entry of data) {
            const sessionId = extractSessionId(entry);
            if (!sessionId) continue;
            sessions.push({
                sessionId,
                updatedAt: extractUpdatedAt(entry),
                title: extractTitle(entry),
                messageCount: extractMessageCount(entry),
                gitBranch: extractGitBranch(entry)
            });
        }
        return sessions;
    }

    return [];
}

export async function listClaudeSessionsFromIndex(): Promise<ClaudeSessionIndexEntry[]> {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const projectsDir = join(claudeConfigDir, 'projects');

    let dirents: Dirent[];
    try {
        dirents = await readdir(projectsDir, { withFileTypes: true }) as Dirent[];
    } catch (error) {
        return [];
    }

    const results: ClaudeSessionIndexEntry[] = [];
    const seen = new Set<string>();

    for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const projectId = dirent.name;
        const indexPath = join(projectsDir, projectId, 'sessions-index.json');
        const projectDir = join(projectsDir, projectId);

        let raw: string;
        try {
            raw = await readFile(indexPath, 'utf8');
        } catch (error) {
            raw = '';
        }

        let data: any;
        if (raw) {
            try {
                data = JSON.parse(raw);
            } catch (error) {
                data = null;
            }
        }

        const originalPath = typeof data?.originalPath === 'string' ? data.originalPath : null;
        if (!originalPath) {
            continue;
        }
        // Get sessions from index (has title/summary info)
        const indexedSessions = extractSessionsFromIndex(data);
        const indexedMap = new Map<string, ParsedSession>();
        for (const session of indexedSessions) {
            indexedMap.set(session.sessionId, session);
        }

        // Always scan .jsonl files to find all sessions (like Claude Code /resume does)
        // Then merge with index data for title/summary info
        const sessions: ParsedSession[] = [];
        try {
            const projectEntries = await readdir(projectDir, { withFileTypes: true }) as Dirent[];
            for (const entry of projectEntries) {
                if (!entry.isFile()) continue;
                if (!entry.name.endsWith('.jsonl')) continue;
                const sessionId = entry.name.replace(/\.jsonl$/, '');
                if (!sessionId) continue;

                // Get metadata from index if available, otherwise use file stats
                const indexed = indexedMap.get(sessionId);
                let updatedAt: number | undefined = indexed?.updatedAt;
                let messageCount: number | undefined = indexed?.messageCount;

                const filePath = join(projectDir, entry.name);

                if (updatedAt === undefined) {
                    try {
                        const stats = await stat(filePath);
                        updatedAt = stats.mtime.getTime();
                    } catch {
                        // ignore stat errors
                    }
                }

                // If messageCount is not in index, count from JSONL file
                if (messageCount === undefined) {
                    messageCount = await countMessagesInJsonl(filePath);
                }

                sessions.push({
                    sessionId,
                    updatedAt,
                    title: indexed?.title ?? null,
                    messageCount,
                    gitBranch: indexed?.gitBranch ?? null
                });
            }
        } catch (error) {
            // If scan fails, fall back to index-only sessions
            sessions.push(...indexedSessions);
        }

        // Extract directory name from originalPath as fallback title
        const dirName = originalPath.split(/[\\/]/).filter(Boolean).pop() || null;

        for (const session of sessions) {
            // Skip sessions without messageCount - they have no context to resume
            if (!session.messageCount) continue;

            const key = `${projectId}:${session.sessionId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
                sessionId: session.sessionId,
                projectId,
                originalPath,
                title: session.title || dirName,
                updatedAt: session.updatedAt,
                messageCount: session.messageCount,
                gitBranch: session.gitBranch
            });
        }
    }

    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return results;
}

/**
 * Preview message from a Claude session JSONL file
 */
export interface ClaudeSessionPreviewMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
}

/**
 * Extract text content from a message object
 * Handles both string content and array content with text blocks
 */
function extractTextContent(message: any): string {
    if (!message || typeof message !== 'object') return '';

    const content = message.content;

    // String content
    if (typeof content === 'string') {
        return content;
    }

    // Array content - extract text blocks
    if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content) {
            if (typeof block === 'string') {
                textParts.push(block);
            } else if (block && typeof block === 'object') {
                if (block.type === 'text' && typeof block.text === 'string') {
                    textParts.push(block.text);
                } else if (block.type === 'tool_result' && typeof block.content === 'string') {
                    // Skip tool results for preview, they're usually verbose
                    continue;
                }
            }
        }
        return textParts.join('\n');
    }

    return '';
}

/**
 * Read last N messages from a Claude session JSONL file
 * Returns messages in chronological order (oldest first)
 */
export async function getClaudeSessionPreview(
    projectId: string,
    sessionId: string,
    limit: number = 10
): Promise<ClaudeSessionPreviewMessage[]> {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const jsonlPath = join(claudeConfigDir, 'projects', projectId, `${sessionId}.jsonl`);

    try {
        // Read the file line by line
        const fileStream = createReadStream(jsonlPath, { encoding: 'utf8' });
        const rl = createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        const allMessages: ClaudeSessionPreviewMessage[] = [];

        for await (const line of rl) {
            if (!line.trim()) continue;

            try {
                const entry = JSON.parse(line);

                // Only extract user and assistant messages
                if (entry.type === 'user' && entry.message?.role === 'user') {
                    const text = extractTextContent(entry.message);
                    if (text) {
                        allMessages.push({
                            role: 'user',
                            content: text,
                            timestamp: entry.timestamp
                        });
                    }
                } else if (entry.type === 'assistant' && entry.message) {
                    const text = extractTextContent(entry.message);
                    if (text) {
                        allMessages.push({
                            role: 'assistant',
                            content: text,
                            timestamp: entry.timestamp
                        });
                    }
                }
            } catch {
                // Skip malformed lines
                continue;
            }
        }

        // Return last N messages (most recent)
        return allMessages.slice(-limit);
    } catch (error) {
        // Return empty array if file doesn't exist or can't be read
        return [];
    }
}

/**
 * User message from a Claude session with UUID for identification
 */
export interface ClaudeUserMessageWithUuid {
    uuid: string;
    content: string;
    timestamp?: string;
    index: number;
}

/**
 * Find the project ID for a given session ID by scanning the projects directory
 * Returns null if the session is not found
 */
export async function findClaudeProjectId(sessionId: string): Promise<string | null> {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const projectsDir = join(claudeConfigDir, 'projects');

    let dirents: Dirent[];
    try {
        dirents = await readdir(projectsDir, { withFileTypes: true }) as Dirent[];
    } catch {
        return null;
    }

    // Search for the session file in each project directory
    for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const projectId = dirent.name;
        const sessionPath = join(projectsDir, projectId, `${sessionId}.jsonl`);

        try {
            await stat(sessionPath);
            // File exists, return this project ID
            return projectId;
        } catch {
            // File doesn't exist in this project, continue searching
            continue;
        }
    }

    return null;
}

/**
 * Get user messages from a Claude session with their UUIDs
 * Used for the duplicate/fork feature to let users select a point to fork from
 */
export async function getClaudeSessionUserMessages(
    projectId: string,
    sessionId: string,
    limit: number = 50
): Promise<ClaudeUserMessageWithUuid[]> {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const jsonlPath = join(claudeConfigDir, 'projects', projectId, `${sessionId}.jsonl`);

    try {
        const fileStream = createReadStream(jsonlPath, { encoding: 'utf8' });
        const rl = createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        const allUserMessages: ClaudeUserMessageWithUuid[] = [];
        const seenUuids = new Set<string>();
        let messageIndex = 0;

        for await (const line of rl) {
            if (!line.trim()) continue;

            try {
                const entry = JSON.parse(line);

                // Only extract user messages with their UUIDs
                if (entry.type === 'user' && entry.message?.role === 'user' && entry.uuid) {
                    // Skip duplicate UUIDs (Claude sometimes writes the same message twice with different formats)
                    if (seenUuids.has(entry.uuid)) {
                        continue;
                    }
                    seenUuids.add(entry.uuid);

                    const text = extractTextContent(entry.message);
                    if (text) {
                        allUserMessages.push({
                            uuid: entry.uuid,
                            content: text,
                            timestamp: entry.timestamp,
                            index: messageIndex
                        });
                        messageIndex++;
                    }
                }
            } catch {
                // Skip malformed lines
                continue;
            }
        }

        // Return last N messages (most recent first for display)
        return allUserMessages.slice(-limit);
    } catch {
        return [];
    }
}
