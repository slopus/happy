#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
    type DecryptedMessage,
    type EncryptionVariant,
    type RawMessage,
    type RawSession,
    type RecordEncryption,
    resolveSessionEncryption,
} from '../../../../packages/happy-agent/src/api';
import { loadConfig, type Config } from '../../../../packages/happy-agent/src/config';
import {
    readCredentials,
    type Credentials,
} from '../../../../packages/happy-agent/src/credentials';
import {
    decodeBase64,
    decrypt,
} from '../../../../packages/happy-agent/src/encryption';

const HELP = `Inspect and decrypt sessions for the locally linked Happy account.

Usage:
  inspect-sessions.ts [options]

Options:
  --limit <n>             Number of recent sessions to inspect (default: 20)
  --messages <n>          Newest messages returned for --session (default: 50)
  --session <id>          Inspect one session by ID or unambiguous prefix
  --tools <a,b,c>         Search selected sessions for named tool calls
  --active                Query only active sessions
  --include-archived      Include sessions whose decrypted lifecycle is archived
  --credentials <path>    Use an existing Happy credential file
  --raw                   Preserve exact decrypted payload values
  --help                  Show this help
`;

type JsonObject = Record<string, unknown>;

type ToolMatch = {
    name: string;
    path: string;
    payload: JsonObject;
};

type PersistedSession = {
    encryptionKey: string;
    encryptionVariant: EncryptionVariant;
    savedAt?: number;
};

type InspectableSession = Omit<RawSession, 'metadata' | 'agentState'> & {
    metadata: unknown | null;
    agentState: unknown | null;
    encryption: RecordEncryption | null;
    decryptionSource: 'account-key' | 'local-session-key' | 'unavailable';
    decryptionError?: string;
};

type InspectionAuth = {
    config: Config;
    token: string;
    accountCredentials: Credentials | null;
    localSessionKeys: Map<string, RecordEncryption>;
    credentialSource: string;
};

const { values } = parseArgs({
    options: {
        limit: { type: 'string', default: '20' },
        messages: { type: 'string', default: '50' },
        session: { type: 'string' },
        tools: { type: 'string' },
        active: { type: 'boolean', default: false },
        'include-archived': { type: 'boolean', default: false },
        credentials: { type: 'string' },
        raw: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
});

if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
}

void main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
});

async function main(): Promise<void> {
    const sessionLimit = positiveInteger(values.limit, '--limit');
    const messageLimit = positiveInteger(values.messages, '--messages');
    const requestedTools = new Set(
        (values.tools ?? '')
            .split(',')
            .map((name) => normalizeToolName(name))
            .filter(Boolean),
    );

    const auth = loadInspectionAuth(loadConfig(), values.credentials);
    const rawSessions = await fetchRawSessions(auth, values.active);
    const allSessions = rawSessions.map((session) => decryptSession(session, auth));
    const sortedSessions = [...allSessions].sort(
        (a, b) => (b.updatedAt || b.activeAt) - (a.updatedAt || a.activeAt),
    );

    const selectedSession = values.session
        ? resolveSessionByPrefix(sortedSessions, values.session)
        : null;
    const recentSessions = selectedSession
        ? [selectedSession]
        : sortedSessions
            .filter((session) => values['include-archived'] || lifecycleOf(session) !== 'archived')
            .slice(0, sessionLimit);

    const account = await fetchAccountProfile(auth);
    const decryptableCount = allSessions.filter((session) => session.encryption !== null).length;
    const output: JsonObject = {
        account: values.raw ? account : redactSensitive(account),
        source: {
            serverUrl: auth.config.serverUrl,
            credential: auth.credentialSource,
            localSessionKeys: auth.localSessionKeys.size,
        },
        coverage: {
            serverSessions: allSessions.length,
            decryptableSessions: decryptableCount,
            unavailableSessions: allSessions.length - decryptableCount,
            accountWide: auth.accountCredentials !== null,
        },
        query: {
            activeOnly: values.active,
            includeArchived: values['include-archived'],
            sessionLimit,
            messageLimit: selectedSession ? messageLimit : undefined,
            tools: requestedTools.size > 0 ? [...requestedTools] : undefined,
            exactPayloadValues: values.raw,
        },
        sessions: recentSessions.map(sessionSummary),
    };

    if (requestedTools.size > 0) {
        const matches: JsonObject[] = [];
        const failures: JsonObject[] = [];

        for (const session of recentSessions) {
            try {
                const messages = await fetchSessionMessages(auth, session);
                for (const message of messages) {
                    const toolMatches = findToolCalls(message.content)
                        .filter((match) => requestedTools.has(normalizeToolName(match.name)));
                    if (toolMatches.length === 0) continue;
                    matches.push({
                        session: sessionSummary(session),
                        message: messageSummary(message),
                        matches: toolMatches.map((match) => ({
                            ...match,
                            payload: values.raw ? match.payload : redactSensitive(match.payload),
                        })),
                    });
                }
            } catch (error) {
                failures.push({
                    sessionId: session.id,
                    error: errorMessage(error),
                });
            }
        }

        output.toolMatches = matches;
        if (failures.length > 0) output.messageFetchFailures = failures;
    } else if (selectedSession) {
        const messages = await fetchSessionMessages(auth, selectedSession);
        output.messages = messages
            .sort((a, b) => a.seq - b.seq)
            .slice(-messageLimit)
            .map((message) => ({
                ...messageSummary(message),
                content: values.raw ? message.content : redactSensitive(message.content),
            }));
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function positiveInteger(value: string | undefined, flag: string): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} must be a positive integer`);
    }
    return parsed;
}

function loadInspectionAuth(config: Config, explicitPath: string | undefined): InspectionAuth {
    const candidates = explicitPath
        ? [resolve(explicitPath)]
        : [config.credentialPath, join(config.homeDir, 'access.key')];

    for (const credentialPath of candidates) {
        const parsed = readCredentialFile(credentialPath);
        if (!parsed || typeof parsed.token !== 'string') continue;

        const candidateConfig = { ...config, credentialPath };
        const accountCredentials = readCredentials(candidateConfig);
        return {
            config: candidateConfig,
            token: parsed.token,
            accountCredentials,
            localSessionKeys: readLocalSessionKeys(join(config.homeDir, 'sessions.json')),
            credentialSource: credentialLabel(credentialPath, config, parsed, accountCredentials),
        };
    }

    const expected = explicitPath
        ? resolve(explicitPath)
        : `${config.credentialPath} or ${join(config.homeDir, 'access.key')}`;
    throw new Error(`No valid Happy credential found at ${expected}`);
}

function readCredentialFile(path: string): JsonObject | null {
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return isObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function credentialLabel(
    path: string,
    config: Config,
    parsed: JsonObject,
    accountCredentials: Credentials | null,
): string {
    if (path === config.credentialPath) return 'agent.key (account-linked)';
    if (accountCredentials || typeof parsed.secret === 'string') {
        return 'access.key (legacy account secret)';
    }
    return 'access.key (modern data-key login)';
}

function readLocalSessionKeys(path: string): Map<string, RecordEncryption> {
    const result = new Map<string, RecordEncryption>();
    if (!existsSync(path)) return result;

    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!isObject(parsed) || !isObject(parsed.sessions)) return result;

        for (const [sessionId, value] of Object.entries(parsed.sessions)) {
            if (!isPersistedSession(value)) continue;
            result.set(sessionId, {
                key: decodeBase64(value.encryptionKey),
                variant: value.encryptionVariant,
            });
        }
    } catch {
        return result;
    }
    return result;
}

function isPersistedSession(value: unknown): value is PersistedSession {
    return isObject(value)
        && typeof value.encryptionKey === 'string'
        && (value.encryptionVariant === 'legacy' || value.encryptionVariant === 'dataKey');
}

async function fetchRawSessions(auth: InspectionAuth, activeOnly: boolean): Promise<RawSession[]> {
    const endpoint = activeOnly ? '/v2/sessions/active' : '/v1/sessions';
    const response = await fetch(`${auth.config.serverUrl}${endpoint}`, {
        headers: authHeaders(auth.token),
    });
    if (!response.ok) {
        throw new Error(`Failed to list sessions (${response.status})`);
    }
    const body = await response.json() as { sessions?: RawSession[] };
    if (!Array.isArray(body.sessions)) {
        throw new Error('Session list response did not contain a sessions array');
    }
    return body.sessions;
}

function decryptSession(raw: RawSession, auth: InspectionAuth): InspectableSession {
    let encryption: RecordEncryption | null = null;
    let decryptionSource: InspectableSession['decryptionSource'] = 'unavailable';

    try {
        if (auth.accountCredentials) {
            encryption = resolveSessionEncryption(raw, auth.accountCredentials);
            decryptionSource = 'account-key';
        } else {
            encryption = auth.localSessionKeys.get(raw.id) ?? null;
            if (encryption) decryptionSource = 'local-session-key';
        }

        if (!encryption) {
            return {
                ...raw,
                metadata: null,
                agentState: null,
                encryption: null,
                decryptionSource,
                decryptionError: 'No local encryption key for this session',
            };
        }

        const metadata = decryptEncodedField(raw.metadata, encryption);
        if (metadata === null) {
            throw new Error('Metadata decryption failed');
        }
        return {
            ...raw,
            metadata,
            agentState: decryptEncodedField(raw.agentState, encryption),
            encryption,
            decryptionSource,
        };
    } catch (error) {
        return {
            ...raw,
            metadata: null,
            agentState: null,
            encryption: null,
            decryptionSource: 'unavailable',
            decryptionError: errorMessage(error),
        };
    }
}

function decryptEncodedField(value: string | null, encryption: RecordEncryption): unknown | null {
    if (!value) return null;
    return decrypt(encryption.key, encryption.variant, decodeBase64(value));
}

async function fetchSessionMessages(
    auth: InspectionAuth,
    session: InspectableSession,
): Promise<DecryptedMessage[]> {
    const encryption = session.encryption;
    if (!encryption) {
        throw new Error(session.decryptionError ?? 'Session encryption key is unavailable');
    }

    const response = await fetch(
        `${auth.config.serverUrl}/v1/sessions/${encodeURIComponent(session.id)}/messages`,
        { headers: authHeaders(auth.token) },
    );
    if (!response.ok) {
        throw new Error(`Failed to fetch messages (${response.status})`);
    }
    const body = await response.json() as { messages?: RawMessage[] };
    if (!Array.isArray(body.messages)) {
        throw new Error('Message response did not contain a messages array');
    }

    return body.messages.map((message) => ({
        id: message.id,
        seq: message.seq,
        content: decryptEncodedField(message.content.c, encryption),
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
    }));
}

async function fetchAccountProfile(auth: InspectionAuth): Promise<unknown> {
    const response = await fetch(`${auth.config.serverUrl}/v1/account/profile`, {
        headers: authHeaders(auth.token),
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch account profile (${response.status})`);
    }
    return response.json();
}

function authHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'X-Happy-Client': 'session-inspector/0.2.0',
    };
}

function resolveSessionByPrefix(sessions: InspectableSession[], value: string): InspectableSession {
    const matches = sessions.filter((session) => session.id.startsWith(value));
    if (matches.length === 0) {
        throw new Error(`No session found matching "${value}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Session prefix "${value}" matches ${matches.length} sessions; use a longer prefix`);
    }
    return matches[0];
}

function sessionSummary(session: InspectableSession): JsonObject {
    return {
        id: session.id,
        seq: session.seq,
        createdAt: isoTime(session.createdAt),
        updatedAt: isoTime(session.updatedAt),
        active: session.active,
        activeAt: isoTime(session.activeAt),
        lifecycle: lifecycleOf(session),
        decryption: session.decryptionSource,
        decryptionError: session.decryptionError,
        metadata: redactSensitive(session.metadata),
        agentState: redactSensitive(session.agentState),
    };
}

function messageSummary(message: DecryptedMessage): JsonObject {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        createdAt: isoTime(message.createdAt),
        updatedAt: isoTime(message.updatedAt),
    };
}

function lifecycleOf(session: InspectableSession): string | null {
    if (!isObject(session.metadata)) return null;
    const lifecycle = session.metadata.lifecycleState;
    return typeof lifecycle === 'string' ? lifecycle : null;
}

function findToolCalls(value: unknown, path = '$', seen = new Set<object>()): ToolMatch[] {
    if (value === null || typeof value !== 'object') return [];
    if (seen.has(value)) return [];
    seen.add(value);

    const matches: ToolMatch[] = [];
    if (isObject(value)) {
        if (value.t === 'tool-call-start' && typeof value.name === 'string') {
            matches.push({ name: value.name, path, payload: value });
        } else if (
            (value.type === 'tool_use' || value.type === 'tool-call')
            && typeof value.name === 'string'
        ) {
            matches.push({ name: value.name, path, payload: value });
        }

        for (const [key, child] of Object.entries(value)) {
            matches.push(...findToolCalls(child, `${path}.${key}`, seen));
        }
    } else {
        for (let index = 0; index < value.length; index += 1) {
            matches.push(...findToolCalls(value[index], `${path}[${index}]`, seen));
        }
    }
    return matches;
}

function normalizeToolName(name: string): string {
    return name.trim().toLowerCase().replace(/^functions[.:/]/, '');
}

function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => redactSensitive(item, seen));
    }

    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
        if (/(^|_)(authorization|cookie|token|secret|private.?key|encryption.?key|data.?encryption.?key)($|_)/i.test(key)) {
            result[key] = '[REDACTED]';
        } else if (
            typeof child === 'string'
            && /^(content|message|objective|prompt|question|script|text)$/i.test(key)
        ) {
            result[key] = `[REDACTED ${child.length} characters]`;
        } else {
            result[key] = redactSensitive(child, seen);
        }
    }
    return result;
}

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isoTime(timestamp: number): string | null {
    if (!timestamp) return null;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}