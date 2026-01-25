import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

export interface ClaudeSessionIndexEntry {
    sessionId: string;
    projectId: string;
    originalPath: string | null;
    title?: string | null;
    updatedAt?: number;
}

type ParsedSession = {
    sessionId: string;
    updatedAt?: number;
    title?: string | null;
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
                title: extractTitle(entry)
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
                title: extractTitle(entry)
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
                title: extractTitle(entry)
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
                title: extractTitle(entry)
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
        let sessions = extractSessionsFromIndex(data);

        // Fallback: scan .jsonl files if index missing or empty
        if (sessions.length === 0) {
            try {
                const projectEntries = await readdir(projectDir, { withFileTypes: true }) as Dirent[];
                const fallbackSessions: ParsedSession[] = [];
                for (const entry of projectEntries) {
                    if (!entry.isFile()) continue;
                    if (!entry.name.endsWith('.jsonl')) continue;
                    const sessionId = entry.name.replace(/\.jsonl$/, '');
                    if (!sessionId) continue;
                    let updatedAt: number | undefined = undefined;
                    try {
                        const stats = await stat(join(projectDir, entry.name));
                        updatedAt = stats.mtime.getTime();
                    } catch {
                        // ignore stat errors
                    }
                    fallbackSessions.push({ sessionId, updatedAt });
                }
                sessions = fallbackSessions;
            } catch (error) {
                // ignore scan errors
            }
        }

        for (const session of sessions) {
            const key = `${projectId}:${session.sessionId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
                sessionId: session.sessionId,
                projectId,
                originalPath,
                title: session.title,
                updatedAt: session.updatedAt
            });
        }
    }

    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return results;
}
