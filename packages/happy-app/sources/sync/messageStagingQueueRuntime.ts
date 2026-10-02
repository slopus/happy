import { v4 as uuid } from 'uuid';
import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { resolveSessionState } from '@/utils/sessionUtils';
import { isSessionArchived } from '@/utils/sessionLifecycle';
import { createMessageStagingQueue } from './messageStagingQueue';
import { clearMessageStagingStorage, initializeMessageStagingPersistence, messageStagingPersistence } from './messageStagingQueuePersistence';
import { storage } from './storage';
import { sync } from './sync';
import { sessionSteer } from './ops';
import { resolveMessageModeMeta } from './messageMeta';
import type { AttachmentPreview } from './attachmentTypes';

export const messageStagingQueue = createMessageStagingQueue({
    ...messageStagingPersistence,
    session(id) {
        const state = storage.getState();
        const session = state.sessions[id];
        if (!session) return undefined;
        const resolved = resolveSessionState(session);
        return {
            connected: accountRuntimeCurrent() && !!sync.getCredentials()
                && !isSessionArchived(session) && state.socketStatus === 'connected' && resolved.isConnected,
            state: resolved.state,
            turnId: session.agentState?.turnStatus?.turnId,
            terminal: ['completed', 'cancelled', 'failed'].includes(session.agentState?.turnStatus?.status ?? ''),
            supportsSteer: session.metadata?.capabilities?.codexSteer === true,
        };
    },
    async send(message) {
        const credentials = sync.getCredentials();
        return sync.sendMessage(message.sessionId, message.text, {
            source: 'chat', attachments: message.attachments, modeMeta: message.modeMeta,
            isCurrent: () => accountRuntimeCurrent() && sync.getCredentials() === credentials,
        });
    },
    async steer(message, expectedTurnId) {
        const credentials = sync.getCredentials();
        const images = await Promise.all((message.attachments ?? []).map(async attachment => {
            if (attachment.kind && attachment.kind !== 'image') throw new Error('Only image attachments can steer a running Codex turn');
            const response = await fetch(attachment.uri);
            if (!response.ok) throw new Error('Image unavailable');
            const blob = await response.blob();
            if (blob.size > 10 * 1024 * 1024) throw new Error('Image too large');
            const data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = () => reject(new Error('Image unavailable'));
                reader.readAsDataURL(blob);
            });
            return { data, mimeType: attachment.mimeType, name: attachment.name };
        }));
        if (!accountRuntimeCurrent() || sync.getCredentials() !== credentials) throw new Error('Account changed');
        return sessionSteer(message.sessionId, { text: message.text, expectedTurnId, clientMessageId: message.id, images });
    },
});

let ready: Promise<void> | undefined;
export function initializeMessageStagingQueue() {
    ready ??= initializeMessageStagingPersistence().then(() => {
        messageStagingQueue.restore(messageStagingPersistence.load());
        messageStagingQueue.refresh();
    });
    return ready;
}

export async function clearMessageStagingQueue() {
    await initializeMessageStagingQueue();
    messageStagingQueue.clear();
    clearMessageStagingStorage();
}

export async function stageSessionMessage(sessionId: string, text: string, attachments?: AttachmentPreview[], delivery: 'queue' | 'steer' = 'queue') {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    if (!session || !accountRuntimeCurrent()) throw new Error('Session unavailable');
    const modeMeta = resolveMessageModeMeta(session, state.settings);
    const selected = attachments?.map(a => ({ ...a }));
    await initializeMessageStagingQueue();
    if (!storage.getState().sessions[sessionId] || !accountRuntimeCurrent()) throw new Error('Session unavailable');
    const id = uuid();
    messageStagingQueue.enqueue({
        id, sessionId, text,
        attachments: selected,
        modeMeta,
    });
    if (delivery === 'steer') await messageStagingQueue.steer(id);
}
