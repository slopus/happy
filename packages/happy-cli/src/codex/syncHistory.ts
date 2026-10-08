import { createHash, createHmac } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';

import { ApiClient } from '@/api/api';
import { ApiSessionClient } from '@/api/apiSession';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { Session } from '@/api/types';
import { configuration } from '@/configuration';
import { persistSession, readPersistedSessions, type Credentials, type PersistedSession } from '@/persistence';
import { readLocalHappyAgentCredentials } from '@/resume/localHappyAgentAuth';
import { resolveSessionEncryption, type RawSession } from '@/resume/resolveHappySession';
import { logger } from '@/ui/logger';
import { createSessionMetadata } from '@/utils/createSessionMetadata';

import { CodexAppServerClient } from './codexAppServerClient';
import type { Thread, ThreadTurn } from './codexAppServerTypes';
import { buildCodexThreadBackfillEnvelopes } from './utils/threadImageBackfill';
import { isCodexTurnInProgress } from './utils/sessionProtocolMapper';

// An omitted source filter excludes exec and subagent records in Codex.
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
    'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

export function codexHistoryKey(credentials: Credentials, tag: string): Uint8Array {
    return credentials.encryption.type === 'legacy' ? credentials.encryption.secret
        : new Uint8Array(createHmac('sha256', credentials.encryption.machineKey).update(tag).digest());
}

/** Keep user-visible summaries; raw reasoning remains only in the native rollout. */
export function historyTurn(turn: ThreadTurn, fallbackTime: number): ThreadTurn {
    return {
        ...turn,
        startedAt: turn.startedAt ?? fallbackTime,
        completedAt: turn.completedAt ?? turn.startedAt ?? fallbackTime,
        items: turn.items.map(item => item.type === 'reasoning'
            ? { type: 'reasoning', id: item.id, summary: item.summary as string[] | undefined }
            : item),
    };
}

function savedSession(session: Session, codexHistory: NonNullable<PersistedSession['codexHistory']>): PersistedSession {
    return {
        encryptionKey: encodeBase64(session.encryptionKey), encryptionVariant: session.encryptionVariant,
        seq: session.seq, metadata: session.metadata, metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion, savedAt: Date.now(), codexHistory,
    };
}

function persistHistory(session: Session, checkpoint: NonNullable<PersistedSession['codexHistory']>) {
    const latest = readPersistedSessions()[session.id];
    persistSession(session.id, latest?.codexHistory?.attached
        ? { ...latest, codexHistory: { ...checkpoint, attached: true } }
        : savedSession(session, checkpoint));
}

async function fetchSessions(token: string): Promise<RawSession[]> {
    const sessions: RawSession[] = [];
    let cursor: string | null = null;
    do {
        const { data }: { data: { sessions: RawSession[]; nextCursor: string | null } } = await axios.get(
            `${configuration.serverUrl}/v2/sessions`, {
                params: { limit: 200, cursor: cursor ?? undefined },
                headers: { Authorization: `Bearer ${token}` }, timeout: 60_000,
            });
        sessions.push(...data.sessions);
        if (data.nextCursor && data.nextCursor === cursor) throw new Error('Happy session pagination stalled');
        cursor = data.nextCursor;
    } while (cursor);
    return sessions;
}

/** Opt-in discovery and encrypted backfill. Never starts a provider thread. */
export async function syncCodexHistory(credentials: Credentials, machineId: string) {
    const stats = { discovered: 0, imported: 0, existing: 0, updated: 0, skipped: 0, failed: 0, unreadable: 0 };
    await mkdir(configuration.happyHomeDir, { recursive: true });
    const lockPath = join(configuration.happyHomeDir, 'codex-history.lock');
    let lock;
    try {
        lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A killed importer must not disable future syncs permanently.
        const pid = Number(await readFile(lockPath, 'utf8'));
        if (!pid && Date.now() - (await stat(lockPath)).mtimeMs < 30_000) return stats;
        try { if (pid) { process.kill(pid, 0); return stats; } } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return stats;
        }
        await unlink(lockPath);
        return syncCodexHistory(credentials, machineId);
    }
    const client = new CodexAppServerClient();
    try {
        await lock.writeFile(String(process.pid));
        const api = await ApiClient.create(credentials);
        const records = readPersistedSessions(true);
        const remote = new Map((await fetchSessions(credentials.token)).map(session => [session.id, session]));
        const existing = new Set<string>();
        const account = readLocalHappyAgentCredentials();
        for (const raw of remote.values()) {
            try {
                const local = records[raw.id];
                const encryption = local ? { key: decodeBase64(local.encryptionKey), variant: local.encryptionVariant }
                    : account ? resolveSessionEncryption(raw, account)
                    : !raw.dataEncryptionKey && credentials.encryption.type === 'legacy'
                        ? { key: credentials.encryption.secret, variant: 'legacy' as const } : null;
                if (!encryption) { stats.unreadable++; continue; }
                const metadata = decrypt(encryption.key, encryption.variant, decodeBase64(raw.metadata));
                if (typeof metadata?.codexThreadId === 'string') {
                    existing.add(metadata.codexThreadId);
                    if (local && !local.metadata.codexThreadId) {
                        persistSession(raw.id, { ...local, metadata: { ...local.metadata, codexThreadId: metadata.codexThreadId } });
                    }
                }
            } catch { stats.unreadable++; }
        }
        const imported = new Map(Object.entries(records).filter(([, record]) => record.codexHistory)
            .map(([id, record]) => [record.metadata.codexThreadId, { id, record }]));
        const { metadata: base } = createSessionMetadata({ flavor: 'codex', machineId });
        await client.connect();
        const threads = new Map<string, Thread>();
        const list = async (archived: boolean, ancestorThreadId?: string) => {
            let cursor: string | null = null;
            do {
                const page = await client.listThreads({ archived, ancestorThreadId,
                    useStateDbOnly: !!ancestorThreadId, sourceKinds: SOURCE_KINDS, cursor: cursor ?? undefined });
                if (ancestorThreadId && page.data.some(thread => thread.id === ancestorThreadId)) {
                    throw new Error('Codex must support ancestorThreadId to discover child history');
                }
                for (const thread of page.data) threads.set(thread.id, { ...thread,
                    historyParentThreadId: threads.get(thread.id)?.historyParentThreadId ?? ancestorThreadId });
                if (page.nextCursor && page.nextCursor === cursor) throw new Error('Codex session pagination stalled');
                cursor = page.nextCursor;
            } while (cursor);
        };
        for (const archived of [false, true]) await list(archived);
        // Codex hides empty previews in its normal list. Descendant queries include them.
        const roots = [...threads.keys()];
        await Promise.all(Array.from({ length: Math.min(8, roots.length) }, async () => {
            while (roots.length) {
                const root = roots.shift()!;
                for (const archived of [false, true]) await list(archived, root);
            }
        }));
        const syncThread = async (thread: Thread) => {
            stats.discovered++;
            try {
                const known = imported.get(thread.id);
                const progress = known?.record.codexHistory;
                const parentThreadId = typeof thread.historyParentThreadId === 'string' ? thread.historyParentThreadId
                    : thread.canAcceptDirectInput === false && typeof thread.parentThreadId === 'string' ? thread.parentThreadId : undefined;
                if (known && known.record.metadata.codexParentThreadId !== parentThreadId) {
                    known.record.metadata = { ...known.record.metadata, codexParentThreadId: parentThreadId };
                    persistHistory({ ...known.record, id: known.id,
                        encryptionKey: decodeBase64(known.record.encryptionKey), agentState: null }, progress!);
                }
                if (known && !remote.has(known.id)) {
                    persistSession(known.id, { ...known.record, codexHistory: { ...progress!, deleted: true } });
                    stats.skipped++;
                    return;
                }
                if (progress?.deleted || progress?.attached) {
                    stats.skipped++;
                    return;
                }
                if (!known && existing.has(thread.id)) { stats.existing++; return; }
                const updatedAt = Number(thread.updatedAt) * 1000;
                if (progress?.updatedAt === updatedAt) { stats.skipped++; return; }
                const history = await client.readThreadHistory(thread.id);
                if (!history.cwd) throw new Error('Native thread has no directory');
                const tag = `codex-history:${machineId}:${thread.id}`;
                const session = known ? {
                    ...remote.get(known.id)!, id: known.id,
                    metadata: known.record.metadata,
                    encryptionKey: decodeBase64(known.record.encryptionKey),
                    encryptionVariant: known.record.encryptionVariant,
                    agentState: null,
                } satisfies Session : await api.getOrCreateSession({
                    tag, encryptionKey: codexHistoryKey(credentials, tag), state: null,
                    metadata: {
                        ...base, path: history.cwd, hostPid: 0, codexThreadId: thread.id,
                        codexParentThreadId: parentThreadId,
                        name: String(thread.name || thread.preview || `Codex ${thread.id.slice(0, 8)}`).split('\n')[0],
                        lifecycleState: 'archived', lifecycleStateSince: updatedAt,
                        lastMeaningfulMessageAt: updatedAt,
                        currentModelCode: typeof thread.model === 'string' ? thread.model : undefined,
                        models: typeof thread.model === 'string' ? [{ code: thread.model, value: thread.model }] : undefined,
                    },
                });
                if (!session?.metadata) throw new Error('Could not create history session');
                const checkpoint = { updatedAt: progress?.updatedAt ?? 0, turns: [...(progress?.turns ?? [])] };
                persistHistory(session, checkpoint);
                if ((!known || remote.get(known.id)?.active) && !await api.deactivateSession(session.id)) {
                    throw new Error('Could not deactivate history session');
                }
                const images = new ApiSessionClient(credentials.token, session, { connect: false });
                try {
                    for (const turn of history.turns ?? []) {
                        if (checkpoint.turns.includes(turn.id) || isCodexTurnInProgress(turn)) continue;
                        const envelopes = await buildCodexThreadBackfillEnvelopes({
                            thread: { turns: [historyTurn(turn, Number(thread.createdAt) * 1000)] },
                            strictImageUpload: true,
                            uploadLocalImage: (attachment, opts) => images.uploadLocalImageAttachmentEnvelope(attachment, opts),
                        });
                        const occurrences = new Map<string, number>();
                        const messages = envelopes.map(envelope => {
                            const key = JSON.stringify([envelope.codexItemId, envelope.subagent, envelope.role, envelope.ev.t]);
                            const index = occurrences.get(key) ?? 0;
                            occurrences.set(key, index + 1);
                            const localId = createHash('sha256').update(`${tag}:${turn.id}:${key}:${index}`).digest('hex');
                            return { localId, content: encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, {
                                role: 'session', content: { ...envelope, id: localId }, meta: { sentFrom: 'cli' },
                            })) };
                        });
                        for (let offset = 0; offset < messages.length;) {
                            const batch = [];
                            let bytes = 0;
                            while (offset < messages.length && batch.length < 50) {
                                const size = Buffer.byteLength(messages[offset].content) + 128;
                                if (batch.length && bytes + size > 800_000) break;
                                batch.push(messages[offset++]);
                                bytes += size;
                            }
                            const { data } = await axios.post<{ messages: Array<{ seq: number }> }>(
                                `${configuration.serverUrl}/v3/sessions/${session.id}/messages`,
                                { messages: batch },
                                { headers: { Authorization: `Bearer ${credentials.token}` }, timeout: 60_000 });
                            session.seq = Math.max(session.seq, ...data.messages.map(message => message.seq));
                        }
                        checkpoint.turns.push(turn.id);
                    }
                } finally { await images.close(); }
                checkpoint.updatedAt = (history.turns ?? []).some(isCodexTurnInProgress) ? 0 : updatedAt;
                // A resume webhook received during the upload owns the live record.
                persistHistory(session, checkpoint);
                if (known) stats.updated++; else stats.imported++;
            } catch (error) {
                stats.failed++;
                logger.debug('[Codex history] Import failed', {
                    threadId: thread.id, errorName: error instanceof Error ? error.name : typeof error,
                    status: axios.isAxiosError(error) ? error.response?.status : undefined,
                });
            }
        };
        const pending = [...threads.values()];
        await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
            while (pending.length) await syncThread(pending.shift()!);
        }));
        return stats;
    } finally {
        await client.disconnect();
        await lock.close();
        await unlink(lockPath).catch(() => {});
    }
}
