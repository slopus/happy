import axios from 'axios';
import { realpath } from 'node:fs/promises';
import type { Metadata } from '@/api/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { ProjectGoalDependencies, ProjectSession } from '@/modules/goalBoard/projectService';
import type { TrackedSession } from './types';
import { independentTaskMessage } from './independentSessions';

type HistorySession = { id: string; metadata: string; seq: number; updatedAt: number; active: boolean };

/** Production relay adapter. Account keys remain in the daemon, never in Task receipts. */
export function createProjectGoalRuntime(options: {
    serverUrl: string; token: string; machineId: string; legacyKey?: Uint8Array;
    findSession: (id: string) => TrackedSession | undefined;
}): Pick<ProjectGoalDependencies, 'history' | 'send'> {
    const headers = { Authorization: `Bearer ${options.token}` };
    const encryptionFor = (id: string) => options.findSession(id)?.encryption ?? (options.legacyKey ? { encryptionKey: options.legacyKey, encryptionVariant: 'legacy' as const } : null);
    return {
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
        history: async (featurePath, tasks) => {
            const sessions: HistorySession[] = [];
            let cursor: string | undefined;
            const seenCursors = new Set<string>();
            // Exhaust a finite catalog. V1's 150 recent sessions cannot prove
            // that an older Task has never been executed. There are no timers.
            do {
                const response = await axios.get(`${options.serverUrl}/v2/sessions`, {
                    params: { limit: 200, ...(cursor ? { cursor } : {}) }, headers, timeout: 15000,
                });
                if (!Array.isArray(response.data.sessions)) throw new Error('Invalid session catalog');
                sessions.push(...response.data.sessions);
                if (!response.data.hasNext) break;
                const next = response.data.nextCursor;
                if (typeof next !== 'string' || seenCursors.has(next) || sessions.length >= 20000) throw new Error('Full task history could not be verified');
                seenCursors.add(next); cursor = next;
            } while (cursor);
            const result: ProjectSession[] = [];
            for (const raw of sessions) {
                const encryption = encryptionFor(raw.id);
                if (!encryption) continue;
                const metadata = decrypt(encryption.encryptionKey, encryption.encryptionVariant, decodeBase64(raw.metadata)) as Metadata | null;
                if (!metadata || metadata.machineId !== options.machineId || typeof metadata.path !== 'string') continue;
                const directory = await realpath(metadata.path).catch(() => metadata.path);
                const task = tasks.find(task => metadata.goalBoard ? metadata.goalBoard.featurePath === featurePath && (metadata.goalBoard.taskId ?? '') === task.id : task.directory === directory);
                if (!task) continue;
                let executed = raw.seq > 0;
                // Ready events do not consume first execution. Only a complete
                // decrypted ready-only transcript can establish an empty chat.
                if (raw.seq > 0 && raw.seq <= 150) {
                    const messages = await axios.get(`${options.serverUrl}/v1/sessions/${encodeURIComponent(raw.id)}/messages`, { headers, timeout: 15000 });
                    const rows = messages.data.messages as Array<{ seq: number; content: { t: string; c?: string } }>;
                    const ordered = [...rows].sort((a, b) => a.seq - b.seq);
                    executed = ordered.length !== raw.seq || ordered.some((row, index) => {
                        const content = row.content?.t === 'encrypted' && row.content.c
                            ? decrypt(encryption.encryptionKey, encryption.encryptionVariant, decodeBase64(row.content.c)) as any : null;
                        return row.seq !== index + 1 || !(content?.role === 'agent' && content.content?.type === 'event' && content.content.data?.type === 'ready');
                    });
                }
                result.push({ sessionId: raw.id, directory, title: metadata.summary?.text || metadata.name || task.title || raw.id,
                    updatedAt: raw.updatedAt, executed, active: raw.active, metadata });
            }
            return result;
        },
    };
}
