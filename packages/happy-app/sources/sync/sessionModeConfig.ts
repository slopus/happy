import type { PermissionMode } from '@/components/PermissionModeSelector';

export type SessionModeAgentType = 'claude' | 'codex' | 'gemini';

export const SESSION_MODE_CONFIG_KV_KEY = 'session-mode-config:v1';
export const SESSION_MODE_CONFIG_SCHEMA_VERSION = 1 as const;
export const MAX_SESSION_MODE_ENTRIES = 100;

export interface SessionModeEntry {
    sessionId: string;
    permissionMode: PermissionMode;
    modelMode: string;
    fastMode?: boolean;
    updatedAt: number;
}

export interface SessionModeLastUsedEntry {
    permissionMode: PermissionMode;
    modelMode: string;
    fastMode?: boolean;
    updatedAt: number;
}

export interface SessionModeConfigDocument {
    schemaVersion: typeof SESSION_MODE_CONFIG_SCHEMA_VERSION;
    updatedAt: number;
    lastUsedByAgent: Partial<Record<SessionModeAgentType, SessionModeLastUsedEntry>>;
    sessions: SessionModeEntry[];
}

export interface SessionModeConfigPatch {
    sessionId?: string;
    permissionMode: PermissionMode;
    modelMode: string;
    fastMode?: boolean;
    agentType: SessionModeAgentType;
    updatedAt: number;
    includeSessionEntry: boolean;
    includeLastUsed: boolean;
}

const PERMISSION_MODES = new Set<PermissionMode>([
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
]);

function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === 'string' && PERMISSION_MODES.has(value as PermissionMode);
}

function sanitizeModelMode(value: unknown): string {
    return typeof value === 'string' && value.length > 0 ? value : 'default';
}

function sanitizeTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function toBase64Utf8(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]!);
    }
    if (typeof btoa === 'function') {
        return btoa(binary);
    }
    return Buffer.from(binary, 'binary').toString('base64');
}

function fromBase64Utf8(value: string): string {
    const binary = typeof atob === 'function'
        ? atob(value)
        : Buffer.from(value, 'base64').toString('binary');
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

function dedupeAndTrimSessionEntries(entries: SessionModeEntry[]): SessionModeEntry[] {
    const bySession = new Map<string, SessionModeEntry>();
    for (const entry of entries) {
        const existing = bySession.get(entry.sessionId);
        if (!existing || entry.updatedAt >= existing.updatedAt) {
            bySession.set(entry.sessionId, entry);
        }
    }
    return Array.from(bySession.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SESSION_MODE_ENTRIES);
}

function normalizeLastUsedEntry(raw: unknown): SessionModeLastUsedEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    if (!isPermissionMode(record.permissionMode)) return null;
    return {
        permissionMode: record.permissionMode,
        modelMode: sanitizeModelMode(record.modelMode),
        ...(typeof record.fastMode === 'boolean' ? { fastMode: record.fastMode } : {}),
        updatedAt: sanitizeTimestamp(record.updatedAt, Date.now()),
    };
}

function normalizeSessionEntry(raw: unknown): SessionModeEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const sessionId = sanitizeSessionId(record.sessionId);
    if (!sessionId || !isPermissionMode(record.permissionMode)) return null;
    return {
        sessionId,
        permissionMode: record.permissionMode,
        modelMode: sanitizeModelMode(record.modelMode),
        ...(typeof record.fastMode === 'boolean' ? { fastMode: record.fastMode } : {}),
        updatedAt: sanitizeTimestamp(record.updatedAt, Date.now()),
    };
}

export function createEmptySessionModeConfig(now: number = Date.now()): SessionModeConfigDocument {
    return {
        schemaVersion: SESSION_MODE_CONFIG_SCHEMA_VERSION,
        updatedAt: now,
        lastUsedByAgent: {},
        sessions: [],
    };
}

export function normalizeSessionModeConfig(input: unknown, now: number = Date.now()): SessionModeConfigDocument {
    if (!input || typeof input !== 'object') {
        return createEmptySessionModeConfig(now);
    }

    const raw = input as Record<string, unknown>;
    const rawLastUsed = raw.lastUsedByAgent;
    const lastUsedByAgent: SessionModeConfigDocument['lastUsedByAgent'] = {};
    if (rawLastUsed && typeof rawLastUsed === 'object') {
        (['claude', 'codex', 'gemini'] as const).forEach((agent) => {
            const entry = normalizeLastUsedEntry((rawLastUsed as Record<string, unknown>)[agent]);
            if (entry) {
                lastUsedByAgent[agent] = entry;
            }
        });
    }

    const rawSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    const sessions = dedupeAndTrimSessionEntries(
        rawSessions
            .map(normalizeSessionEntry)
            .filter((entry): entry is SessionModeEntry => !!entry),
    );

    return {
        schemaVersion: SESSION_MODE_CONFIG_SCHEMA_VERSION,
        updatedAt: sanitizeTimestamp(raw.updatedAt, now),
        lastUsedByAgent,
        sessions,
    };
}

export function encodeSessionModeConfigValue(doc: SessionModeConfigDocument): string {
    const normalized = normalizeSessionModeConfig(doc, doc.updatedAt);
    return toBase64Utf8(JSON.stringify(normalized));
}

export function decodeSessionModeConfigValue(value: string | null | undefined): SessionModeConfigDocument {
    if (!value) {
        return createEmptySessionModeConfig();
    }
    try {
        const decoded = fromBase64Utf8(value);
        const parsed = JSON.parse(decoded);
        return normalizeSessionModeConfig(parsed);
    } catch {
        return createEmptySessionModeConfig();
    }
}

export function applySessionModeConfigPatch(
    doc: SessionModeConfigDocument,
    patch: SessionModeConfigPatch,
): SessionModeConfigDocument {
    const normalized = normalizeSessionModeConfig(doc, patch.updatedAt);
    let sessions = normalized.sessions;

    if (patch.includeSessionEntry && patch.sessionId) {
        const sessionId = patch.sessionId.trim();
        if (sessionId) {
            sessions = dedupeAndTrimSessionEntries([
                ...sessions,
                {
                    sessionId,
                    permissionMode: patch.permissionMode,
                    modelMode: sanitizeModelMode(patch.modelMode),
                    ...(typeof patch.fastMode === 'boolean' ? { fastMode: patch.fastMode } : {}),
                    updatedAt: patch.updatedAt,
                },
            ]);
        }
    }

    const lastUsedByAgent = { ...normalized.lastUsedByAgent };
    if (patch.includeLastUsed) {
        lastUsedByAgent[patch.agentType] = {
            permissionMode: patch.permissionMode,
            modelMode: sanitizeModelMode(patch.modelMode),
            ...(typeof patch.fastMode === 'boolean' ? { fastMode: patch.fastMode } : {}),
            updatedAt: patch.updatedAt,
        };
    }

    return {
        schemaVersion: SESSION_MODE_CONFIG_SCHEMA_VERSION,
        updatedAt: Math.max(normalized.updatedAt, patch.updatedAt),
        sessions,
        lastUsedByAgent,
    };
}

export function applySessionModeConfigPatches(
    doc: SessionModeConfigDocument,
    patches: SessionModeConfigPatch[],
): SessionModeConfigDocument {
    let next = doc;
    for (const patch of patches) {
        next = applySessionModeConfigPatch(next, patch);
    }
    return next;
}

export function getSessionModeForSession(
    doc: SessionModeConfigDocument | null | undefined,
    sessionId: string,
): SessionModeEntry | null {
    if (!doc) return null;
    const targetId = sessionId.trim();
    if (!targetId) return null;
    return doc.sessions.find(v => v.sessionId === targetId) ?? null;
}

export function getLastUsedForAgent(
    doc: SessionModeConfigDocument | null | undefined,
    agentType: SessionModeAgentType,
): SessionModeLastUsedEntry | null {
    if (!doc) return null;
    return doc.lastUsedByAgent[agentType] ?? null;
}
