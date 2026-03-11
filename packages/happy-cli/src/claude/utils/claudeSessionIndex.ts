import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Dirent } from 'node:fs';
import {
    loadSessionMetadataCache,
    normalizeSessionTitle,
    saveSessionMetadataCache
} from '@/cache/sessionMetadataCache';

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

type ClaudeConversationNodeType = 'user' | 'assistant' | 'attachment' | 'system';

interface ClaudeConversationNode {
    uuid: string;
    parentUuid: string | null;
    timestamp?: number;
    type: ClaudeConversationNodeType;
    isMeta: boolean;
    isSidechain: boolean;
    userContent?: unknown;
}

interface ClaudeParsedSessionFileMetadata {
    title: string | null;
    messageCount: number;
    updatedAt?: number;
    gitBranch?: string | null;
}

interface ClaudeSessionMetadataCacheEntry {
    fileMtimeMs: number;
    fileSize: number;
    title: string | null;
    titleExtracted: boolean;
    messageCount?: number;
    updatedAt?: number;
    gitBranch?: string | null;
}

const CLAUDE_SESSION_METADATA_CACHE_VERSION = 1;
const CLAUDE_SESSION_METADATA_CACHE_FILENAME = 'claude-session-metadata-cache.json';
const CONTINUATION_PREFIX = 'This session is being continued';
const IDE_MESSAGE_PREFIX = '<ide_';

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

function extractTextFromUserContent(content: unknown, skipContinuation: boolean): string | null {
    const sanitize = (raw: string): string | null => {
        const text = raw.trim();
        if (!text) return null;
        if (text.startsWith(IDE_MESSAGE_PREFIX)) return null;
        if (skipContinuation && text.startsWith(CONTINUATION_PREFIX)) return null;
        return text;
    };

    if (typeof content === 'string') {
        return sanitize(content);
    }

    if (!Array.isArray(content)) {
        return null;
    }

    for (const block of content) {
        if (typeof block === 'string') {
            const text = sanitize(block);
            if (text) return text;
            continue;
        }
        if (!block || typeof block !== 'object') continue;
        if ((block as { type?: unknown }).type !== 'text') continue;
        const textValue = (block as { text?: unknown }).text;
        if (typeof textValue !== 'string') continue;
        const text = sanitize(textValue);
        if (text) return text;
    }

    return null;
}

function getTranscript(nodes: Map<string, ClaudeConversationNode>, leafUuid: string): ClaudeConversationNode[] {
    const chain: ClaudeConversationNode[] = [];
    let current: ClaudeConversationNode | undefined = nodes.get(leafUuid);
    while (current) {
        chain.push(current);
        if (!current.parentUuid) break;
        current = nodes.get(current.parentUuid);
    }
    return chain.reverse();
}

function isSidechainBranch(nodes: Map<string, ClaudeConversationNode>, leafUuid: string): boolean {
    let current: ClaudeConversationNode | undefined = nodes.get(leafUuid);
    while (current) {
        if (!current.parentUuid) {
            return current.isSidechain;
        }
        current = nodes.get(current.parentUuid);
    }
    return false;
}

function getFirstMeaningfulUserMessage(transcript: ClaudeConversationNode[]): string | null {
    for (const node of transcript) {
        if (node.type !== 'user' || node.isMeta) continue;
        const strictText = extractTextFromUserContent(node.userContent, true);
        if (strictText) return normalizeSessionTitle(strictText);
        const fallbackText = extractTextFromUserContent(node.userContent, false);
        if (fallbackText) return normalizeSessionTitle(fallbackText);
    }
    return null;
}

function pickConversationTitleFromGraph(
    nodes: Map<string, ClaudeConversationNode>,
    parentUuids: Set<string>,
    summariesByLeaf: Map<string, string>
): string | null {
    const leafUuids: string[] = [];
    for (const uuid of nodes.keys()) {
        if (!parentUuids.has(uuid)) {
            leafUuids.push(uuid);
        }
    }
    if (leafUuids.length === 0) return null;

    const nonSidechainLeafUuids = leafUuids.filter((leafUuid) => !isSidechainBranch(nodes, leafUuid));
    const candidateLeafs = nonSidechainLeafUuids.length > 0 ? nonSidechainLeafUuids : leafUuids;
    candidateLeafs.sort((a, b) => (nodes.get(b)?.timestamp || 0) - (nodes.get(a)?.timestamp || 0));
    const latestLeafUuid = candidateLeafs[0];
    if (!latestLeafUuid) return null;

    const summary = summariesByLeaf.get(latestLeafUuid);
    if (summary) {
        const normalized = normalizeSessionTitle(summary);
        if (normalized) return normalized;
    }

    const transcript = getTranscript(nodes, latestLeafUuid);
    return getFirstMeaningfulUserMessage(transcript);
}

function isConversationNodeType(value: unknown): value is ClaudeConversationNodeType {
    return value === 'user' || value === 'assistant' || value === 'attachment' || value === 'system';
}

async function parseClaudeSessionFileMetadata(jsonlPath: string): Promise<ClaudeParsedSessionFileMetadata> {
    const fileStream = createReadStream(jsonlPath, { encoding: 'utf8' });
    const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const nodes = new Map<string, ClaudeConversationNode>();
    const parentUuids = new Set<string>();
    const summariesByLeaf = new Map<string, string>();
    let messageCount = 0;
    let latestTimestamp: number | undefined;
    let gitBranch: string | null = null;

    try {
        for await (const line of rl) {
            if (!line.trim()) continue;

            let entry: any;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }

            if (entry?.type === 'summary' && typeof entry?.leafUuid === 'string') {
                const rawSummary = typeof entry?.summary === 'string' ? entry.summary.trim() : '';
                if (rawSummary) {
                    summariesByLeaf.set(entry.leafUuid, rawSummary);
                }
                continue;
            }

            if (!isConversationNodeType(entry?.type)) {
                continue;
            }
            if (typeof entry?.uuid !== 'string' || !entry.uuid) {
                continue;
            }

            const parentUuid = typeof entry?.parentUuid === 'string' && entry.parentUuid.trim()
                ? entry.parentUuid
                : null;
            if (parentUuid) {
                parentUuids.add(parentUuid);
            }

            const timestamp = parseTimestamp(entry?.timestamp);
            if (timestamp !== undefined) {
                latestTimestamp = Math.max(latestTimestamp ?? 0, timestamp);
            }

            if (!gitBranch && typeof entry?.gitBranch === 'string' && entry.gitBranch.trim()) {
                gitBranch = entry.gitBranch.trim();
            }

            if (entry.type === 'user') {
                messageCount++;
            }

            nodes.set(entry.uuid, {
                uuid: entry.uuid,
                parentUuid,
                timestamp,
                type: entry.type,
                isMeta: entry?.isMeta === true,
                isSidechain: entry?.isSidechain === true,
                userContent: entry?.type === 'user' ? entry?.message?.content : undefined
            });
        }
    } catch {
        // If parsing fails we still return whatever we gathered.
    } finally {
        rl.close();
        fileStream.destroy();
    }

    const title = pickConversationTitleFromGraph(nodes, parentUuids, summariesByLeaf);
    return {
        title,
        messageCount,
        updatedAt: latestTimestamp,
        gitBranch
    };
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
    } catch {
        return [];
    }

    const existingCacheEntries = await loadSessionMetadataCache<ClaudeSessionMetadataCacheEntry>({
        cacheFileName: CLAUDE_SESSION_METADATA_CACHE_FILENAME,
        cacheVersion: CLAUDE_SESSION_METADATA_CACHE_VERSION,
        scopeKey: 'claudeConfigDir',
        scopeValue: claudeConfigDir
    });
    const nextCacheEntries: Record<string, ClaudeSessionMetadataCacheEntry> = { ...existingCacheEntries };
    const seenCacheKeys = new Set<string>();
    const scannedProjectIds = new Set<string>();
    let cacheDirty = false;

    const results: ClaudeSessionIndexEntry[] = [];
    const seen = new Set<string>();

    for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const projectId = dirent.name;
        const indexPath = join(projectsDir, projectId, 'sessions-index.json');
        const projectDir = join(projectsDir, projectId);

        let raw = '';
        try {
            raw = await readFile(indexPath, 'utf8');
        } catch {
            raw = '';
        }

        let data: any = null;
        if (raw) {
            try {
                data = JSON.parse(raw);
            } catch {
                data = null;
            }
        }

        const originalPath = typeof data?.originalPath === 'string' ? data.originalPath : null;
        if (!originalPath) {
            continue;
        }

        const indexedSessions = extractSessionsFromIndex(data);
        const indexedMap = new Map<string, ParsedSession>();
        for (const session of indexedSessions) {
            indexedMap.set(session.sessionId, session);
        }

        const sessions: ParsedSession[] = [];
        try {
            scannedProjectIds.add(projectId);
            const projectEntries = await readdir(projectDir, { withFileTypes: true }) as Dirent[];
            for (const entry of projectEntries) {
                if (!entry.isFile()) continue;
                if (!entry.name.endsWith('.jsonl')) continue;
                if (entry.name.startsWith('agent-')) continue;

                const sessionId = entry.name.replace(/\.jsonl$/, '');
                if (!sessionId) continue;

                const indexed = indexedMap.get(sessionId);
                const filePath = join(projectDir, entry.name);
                const cacheKey = `${projectId}:${sessionId}`;
                seenCacheKeys.add(cacheKey);

                let stats;
                try {
                    stats = await stat(filePath);
                } catch {
                    stats = null;
                }

                let cached = nextCacheEntries[cacheKey];
                const cacheMatchesFile = !!(
                    cached &&
                    stats &&
                    cached.fileMtimeMs === stats.mtimeMs &&
                    cached.fileSize === stats.size
                );

                const needsTitleFromFile = indexed?.title == null && (!cacheMatchesFile || cached?.titleExtracted !== true);
                const needsMessageCountFromFile = indexed?.messageCount === undefined && (!cacheMatchesFile || cached?.messageCount === undefined);
                const needsUpdatedAtFromFile = indexed?.updatedAt === undefined && (!cacheMatchesFile || cached?.updatedAt === undefined);
                const needsGitBranchFromFile = indexed?.gitBranch == null && (!cacheMatchesFile || cached?.gitBranch == null);
                const shouldParseFile = !!stats && (needsTitleFromFile || needsMessageCountFromFile || needsUpdatedAtFromFile || needsGitBranchFromFile);

                if (shouldParseFile && stats) {
                    const parsedMetadata = await parseClaudeSessionFileMetadata(filePath);
                    cached = {
                        fileMtimeMs: stats.mtimeMs,
                        fileSize: stats.size,
                        title: parsedMetadata.title,
                        titleExtracted: true,
                        messageCount: parsedMetadata.messageCount,
                        updatedAt: parsedMetadata.updatedAt,
                        gitBranch: parsedMetadata.gitBranch ?? null
                    };
                    nextCacheEntries[cacheKey] = cached;
                    cacheDirty = true;
                } else if (!cacheMatchesFile && stats && indexed?.messageCount !== undefined && indexed?.title != null) {
                    // Keep cache in sync with file metadata even if we didn't need to parse the file.
                    cached = {
                        fileMtimeMs: stats.mtimeMs,
                        fileSize: stats.size,
                        title: null,
                        titleExtracted: false,
                        messageCount: undefined,
                        updatedAt: undefined,
                        gitBranch: null
                    };
                    nextCacheEntries[cacheKey] = cached;
                    cacheDirty = true;
                }

                const updatedAt = indexed?.updatedAt
                    ?? cached?.updatedAt
                    ?? stats?.mtimeMs;
                const messageCount = indexed?.messageCount
                    ?? cached?.messageCount;
                const title = indexed?.title
                    ?? cached?.title
                    ?? null;
                const gitBranch = indexed?.gitBranch
                    ?? cached?.gitBranch
                    ?? null;

                sessions.push({
                    sessionId,
                    updatedAt,
                    title,
                    messageCount,
                    gitBranch
                });
            }
        } catch {
            // If scan fails, fall back to index-only sessions
            sessions.push(...indexedSessions);
        }

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

    // Remove stale cache entries for projects we successfully scanned.
    for (const cacheKey of Object.keys(nextCacheEntries)) {
        const separator = cacheKey.indexOf(':');
        if (separator <= 0) continue;
        const projectId = cacheKey.slice(0, separator);
        if (!scannedProjectIds.has(projectId)) continue;
        if (seenCacheKeys.has(cacheKey)) continue;
        delete nextCacheEntries[cacheKey];
        cacheDirty = true;
    }

    if (cacheDirty) {
        await saveSessionMetadataCache({
            cacheFileName: CLAUDE_SESSION_METADATA_CACHE_FILENAME,
            cacheVersion: CLAUDE_SESSION_METADATA_CACHE_VERSION,
            scopeKey: 'claudeConfigDir',
            scopeValue: claudeConfigDir,
            entries: nextCacheEntries
        });
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
