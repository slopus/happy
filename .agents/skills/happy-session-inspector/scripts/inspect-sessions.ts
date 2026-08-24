#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import type {
    RawMessage,
    RawSession,
    RecordEncryption,
} from '../../../../packages/happy-agent/src/api';
import { decodeBase64, decrypt } from '../../../../packages/happy-agent/src/encryption';

type JsonObject = Record<string, unknown>;
type Session = Omit<RawSession, 'metadata' | 'agentState'> & {
    metadata: unknown | null;
    agentState: unknown | null;
    encryption: RecordEncryption | null;
    decryptionError?: string;
};

const { values } = parseArgs({
    options: {
        limit: { type: 'string', default: '20' },
        messages: { type: 'string', default: '50' },
        session: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
});

if (values.help) {
    process.stdout.write('Usage: inspect-sessions.ts [--limit 20] [--session <id-or-prefix>] [--messages 50]\n');
    process.exit(0);
}

void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});

async function main(): Promise<void> {
    const happyHome = process.env.HAPPY_HOME_DIR ?? join(homedir(), '.happy');
    const serverUrl = (process.env.HAPPY_SERVER_URL ?? 'https://api.cluster-fluster.com').replace(/\/+$/, '');
    const access = readObject(join(happyHome, 'access.key'));
    if (typeof access?.token !== 'string') throw new Error(`No Happy login found in ${happyHome}`);

    const keys = readSessionKeys(join(happyHome, 'sessions.json'));
    const response = await fetch(`${serverUrl}/v1/sessions`, { headers: authHeaders(access.token) });
    if (!response.ok) throw new Error(`Failed to list sessions (${response.status})`);

    const body = await response.json() as { sessions?: RawSession[] };
    if (!Array.isArray(body.sessions)) throw new Error('Invalid session-list response');
    const sessions = body.sessions
        .map((session) => decryptSession(session, keys.get(session.id)))
        .sort((a, b) => (b.updatedAt || b.activeAt) - (a.updatedAt || a.activeAt));

    if (values.session) {
        const session = findSession(sessions, values.session);
        const messages = await fetchMessages(serverUrl, access.token, session);
        print({
            session: sessionOutput(session),
            messages: messages
                .sort((a, b) => a.seq - b.seq)
                .slice(-positiveInteger(values.messages, '--messages')),
        });
        return;
    }

    print({
        sessions: sessions
            .filter((session) => lifecycle(session.metadata) !== 'archived')
            .slice(0, positiveInteger(values.limit, '--limit'))
            .map(sessionOutput),
    });
}

function readSessionKeys(path: string): Map<string, RecordEncryption> {
    const keys = new Map<string, RecordEncryption>();
    const sessions = readObject(path)?.sessions;
    if (!isObject(sessions)) return keys;

    for (const [id, value] of Object.entries(sessions)) {
        if (!isObject(value) || typeof value.encryptionKey !== 'string') continue;
        if (value.encryptionVariant !== 'legacy' && value.encryptionVariant !== 'dataKey') continue;
        keys.set(id, { key: decodeBase64(value.encryptionKey), variant: value.encryptionVariant });
    }
    return keys;
}

function decryptSession(raw: RawSession, encryption?: RecordEncryption): Session {
    if (!encryption) {
        return { ...raw, metadata: null, agentState: null, encryption: null, decryptionError: 'No local key' };
    }
    return {
        ...raw,
        metadata: decryptField(raw.metadata, encryption),
        agentState: decryptField(raw.agentState, encryption),
        encryption,
    };
}

async function fetchMessages(serverUrl: string, token: string, session: Session): Promise<JsonObject[]> {
    if (!session.encryption) throw new Error(session.decryptionError ?? 'Session key unavailable');
    const response = await fetch(
        `${serverUrl}/v1/sessions/${encodeURIComponent(session.id)}/messages`,
        { headers: authHeaders(token) },
    );
    if (!response.ok) throw new Error(`Failed to fetch messages (${response.status})`);

    const body = await response.json() as { messages?: RawMessage[] };
    if (!Array.isArray(body.messages)) throw new Error('Invalid message response');
    return body.messages.map((message) => ({
        id: message.id,
        seq: message.seq,
        createdAt: message.createdAt,
        content: decryptField(message.content.c, session.encryption!),
    }));
}

function decryptField(value: string | null, encryption: RecordEncryption): unknown | null {
    return value ? decrypt(encryption.key, encryption.variant, decodeBase64(value)) : null;
}

function findSession(sessions: Session[], prefix: string): Session {
    const matches = sessions.filter((session) => session.id.startsWith(prefix));
    if (matches.length !== 1) {
        throw new Error(matches.length === 0
            ? `No session matches "${prefix}"`
            : `Session prefix "${prefix}" matches ${matches.length} sessions`);
    }
    return matches[0];
}

function sessionOutput(session: Session): JsonObject {
    return {
        id: session.id,
        createdAt: new Date(session.createdAt).toISOString(),
        updatedAt: new Date(session.updatedAt).toISOString(),
        active: session.active,
        metadata: session.metadata,
        agentState: session.agentState,
        decryptionError: session.decryptionError,
    };
}

function lifecycle(metadata: unknown): string | undefined {
    return isObject(metadata) && typeof metadata.lifecycleState === 'string'
        ? metadata.lifecycleState
        : undefined;
}

function readObject(path: string): JsonObject | null {
    if (!existsSync(path)) return null;
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return isObject(value) ? value : null;
    } catch {
        return null;
    }
}

function positiveInteger(value: string | undefined, flag: string): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
    return parsed;
}

function authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'X-Happy-Client': 'session-inspector/1.0' };
}

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function print(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
