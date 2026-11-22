import { digest } from '@/modules/goalBoard/parser';
import { isStableTaskId } from '@/modules/goalBoard/taskIdentity';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { Metadata } from '@/api/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { ProjectGoalDependencies, ProjectSession } from '@/modules/goalBoard/projectService';
import type { TrackedSession } from './types';
import { independentTaskMessage } from './independentSessions';
import { createProjectConversationCatalog, type ProjectConversationRawHeader } from './projectConversationCatalog';

type HistorySession = ProjectConversationRawHeader;

/** Production relay adapter. Account keys remain in the daemon, never in Task receipts. */
export function createProjectGoalRuntime(options: {
    serverUrl: string; token: string; machineId: string; legacyKey?: Uint8Array;
    findSession: (id: string) => TrackedSession | undefined;
    now?: () => number;
}): Pick<ProjectGoalDependencies, 'history' | 'send' | 'conversationCatalog' | 'releaseConversationCatalog' | 'disposeConversationCatalog'> {
    const headers = { Authorization: `Bearer ${options.token}` };
    const encryptionFor = (id: string) => options.findSession(id)?.encryption ?? (options.legacyKey ? { encryptionKey: options.legacyKey, encryptionVariant: 'legacy' as const } : null);
    const readCatalog = async (maxBytes?: number) => {
        const sessions: HistorySession[] = [];
        let bytes = 2;
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        // Exhaust a finite catalog. V1's 150 recent sessions cannot prove
        // that an older Task has never been executed. There are no timers.
        do {
            const response = await axios.get(`${options.serverUrl}/v2/sessions`, {
                params: { limit: 200, ...(cursor ? { cursor } : {}) }, headers, timeout: 15000,
            });
            if (!Array.isArray(response.data.sessions)) throw new Error('Invalid session catalog');
            for (const row of response.data.sessions) {
                const header = { id: row.id, metadata: row.metadata, metadataVersion: row.metadataVersion,
                    dataEncryptionKey: row.dataEncryptionKey ?? null, seq: row.seq, updatedAt: row.updatedAt, active: row.active };
                bytes += Buffer.byteLength(JSON.stringify(header)) + 1;
                if (maxBytes !== undefined && bytes > maxBytes) throw new Error('Conversation catalog snapshot byte limit exceeded');
                sessions.push(header);
            }
            if (!response.data.hasNext) break;
            const next = response.data.nextCursor;
            if (typeof next !== 'string' || seenCursors.has(next) || sessions.length >= 20000) throw new Error('Full task history could not be verified');
            seenCursors.add(next); cursor = next;
        } while (cursor);
        return sessions;
    };
    const catalog = createProjectConversationCatalog(() => readCatalog(64 * 1024 * 1024), options.now);
    return {
        disposeConversationCatalog: () => catalog.dispose(),
        conversationCatalog: (projectPath, input) => catalog.page(projectPath, input),
        releaseConversationCatalog: (projectPath, snapshotId) => catalog.release(projectPath, snapshotId),
        send: async (sessionId, prompt, localId) => {
            const child = options.findSession(sessionId);
            if (!child?.encryption) throw new Error('Task session encryption is unavailable');
            const e = child.encryption;
            const message = independentTaskMessage(prompt, 'default');
            message.meta.sentFrom = 'paws-goal-project';
            const response = await axios.post(`${options.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`, {
                messages: [{ localId, content: encodeBase64(encrypt(e.encryptionKey, e.encryptionVariant, message)) }],
            }, { headers, timeout: 15000 });
            if (!Array.isArray(response.data?.messages) || !response.data.messages.some((message: { localId?: unknown }) => message.localId === localId)) throw new Error('Task submission acknowledgement is missing');
        },
        history: async (featurePath, tasks, historyOptions) => {
            const sessions = historyOptions?.snapshotId
                ? catalog.read(featurePath, historyOptions.snapshotId, historyOptions.catalogFingerprint)
                : await readCatalog();
            const candidates = historyOptions?.headerCandidates;
            const candidateById = candidates ? new Map(candidates.map(candidate => [candidate.sessionId, candidate])) : undefined;
            if (candidates) {
                if (sessions.some(session => typeof session.id !== 'string' || !Number.isInteger(session.metadataVersion) || session.metadataVersion! < 0))
                    throw new Error('Invalid session catalog metadata');
                const pairs = [...new Map(sessions.map(session => [session.id, session.metadataVersion!])).entries()]
                    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
                const fingerprint = createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
                if (historyOptions?.catalogFingerprint !== fingerprint) throw new Error('Session catalog changed; refresh conversations');
                if (candidateById!.size !== candidates.length) throw new Error('Conversation candidate identities are duplicated');
                const authoritative = new Map(sessions.map(session => [session.id, session]));
                for (const candidate of candidates) {
                    const raw = authoritative.get(candidate.sessionId);
                    if (!raw) throw new Error('Conversation candidate is outside the authenticated session catalog');
                    if (raw.metadataVersion !== candidate.metadataVersion) throw new Error('Session metadata changed; refresh conversations');
                }
            }
            const result: ProjectSession[] = [];
            for (const raw of sessions) {
                const candidate = candidateById?.get(raw.id);
                if (candidateById && !candidate) continue;
                const encryption = candidate ? null : encryptionFor(raw.id);
                if (!candidate && !encryption) { if (historyOptions?.headersOnly) throw new Error('Complete session history encryption is unavailable'); continue; }
                const metadata: Metadata | null = candidate ? { path: candidate.directory, machineId: options.machineId,
                    ...(candidate.featurePath ? { goalBoard: { featurePath: candidate.featurePath, ...(candidate.taskId ? { taskId: candidate.taskId } : {}) } } : {}),
                    lifecycleState: candidate.lifecycleState } as Metadata
                    : decrypt(encryption!.encryptionKey, encryption!.encryptionVariant, decodeBase64(raw.metadata)) as Metadata | null;
                if (!metadata) { if (historyOptions?.headersOnly) throw new Error('Complete session history could not be decrypted'); continue; }
                if (metadata.machineId !== options.machineId || typeof metadata.path !== 'string') continue;
                const directory = await realpath(metadata.path).catch(() => metadata.path);
                const task = tasks.find(task => {
                    const directories = task.directories ?? [task.directory];
                    const binding = metadata.goalBoard;
                    if (task.sessionIds?.includes(raw.id)) return !binding?.taskId || !isStableTaskId(binding.taskId) || binding.taskId === task.id;
                    if (!binding) return directories.includes(directory) || directories.includes(metadata.path);
                    if (isStableTaskId(task.id) && binding.taskId === task.id) return true;
                    return (binding.featurePath === (task.featurePath ?? featurePath) && (binding.taskId ?? '') === task.id) ||
                        directories.some(path => digest(`${path}/index.md`) === binding.taskId);
                });
                if (!task) continue;
                let executed = raw.seq > 0;
                // Ready events do not consume first execution. Only a complete
                // decrypted ready-only transcript can establish an empty chat.
                if (!historyOptions?.headersOnly && raw.seq > 0 && raw.seq <= 150) {
                    const messages = await axios.get(`${options.serverUrl}/v1/sessions/${encodeURIComponent(raw.id)}/messages`, { headers, timeout: 15000 });
                    const rows = messages.data.messages as Array<{ seq: number; content: { t: string; c?: string } }>;
                    const ordered = [...rows].sort((a, b) => a.seq - b.seq);
                    executed = ordered.length !== raw.seq || ordered.some((row, index) => {
                        const content = row.content?.t === 'encrypted' && row.content.c
                            ? decrypt(encryption!.encryptionKey, encryption!.encryptionVariant, decodeBase64(row.content.c)) as any : null;
                        return row.seq !== index + 1 || !(content?.role === 'agent' && content.content?.type === 'event' && content.content.data?.type === 'ready');
                    });
                }
                result.push({ sessionId: raw.id, directory: task.directory, title: candidate?.title || metadata.summary?.text || metadata.name || task.title || raw.id,
                    updatedAt: raw.updatedAt, executed, active: raw.active, metadata });
            }
            return result;
        },
    };
}
