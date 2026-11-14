import { parseComposerDraft, composerReferenceDisplay } from './composerReferences';
import { v4 as uuid } from 'uuid';
import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { resolveSessionState } from '@/utils/sessionUtils';
import { isArchivedLifecycleState } from '@/utils/sessionLifecycle';
import { createMessageStagingQueue, StagedAttachmentSaveError } from './messageStagingQueue';
import { clearMessageStagingStorage, getMessageStagingNamespace, initializeMessageStagingPersistence, messageStagingPersistence } from './messageStagingQueuePersistence';
import { deleteStagedAttachments, persistStagedAttachments, restoreStagedAttachments } from './stagedAttachmentStorage';
import { storage } from './storage';
import { sync } from './sync';
import { sessionSteer } from './ops';
import { resolveMessageModeMeta } from './messageMeta';
import type { StagedMessage } from './messageStagingQueue';
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
                && !isArchivedLifecycleState(session.metadata?.lifecycleState) && state.socketStatus === 'connected' && resolved.isConnected,
            state: resolved.state,
            turnId: session.agentState?.turnStatus?.turnId,
            terminal: ['completed', 'cancelled', 'failed'].includes(session.agentState?.turnStatus?.status ?? ''),
            supportsSteer: session.metadata?.capabilities?.codexSteer === true,
        };
    },
    async prepare(message) {
        const draft = parseComposerDraft(message.text);
        if (!draft.references.length) return undefined;
        const credentials = sync.getCredentials();
        const prepared = await sync.prepareComposerMessage(message.text, () => accountRuntimeCurrent() && sync.getCredentials() === credentials);
        return { ...prepared, ...(message.displayText !== undefined ? { displayText: composerReferenceDisplay(parseComposerDraft(message.displayText).text, draft.references) } : {}) };
    },
    async send(message) {
        const credentials = sync.getCredentials();
        return sync.sendMessage(message.sessionId, message.text, {
            source: 'chat', attachments: message.attachments, modeMeta: message.modeMeta,
            ...((message.displayText ?? message.draftText) !== undefined ? { displayText: message.displayText ?? (message.draftText || (message.fileReference ? '@ ' + message.fileReference.path.split('/').pop() : message.draftText)) } : {}),
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

// A transport acknowledgement is not proof that the next turn has run. Keep
// both staged messages (including failures) and submission barriers visible.
messageStagingQueue.subscribe(() => {
    const snapshot = messageStagingQueue.getSnapshot();
    storage.getState().applyPendingMessageSessions(new Set([
        ...snapshot.messages.map(message => message.sessionId), ...Object.keys(snapshot.barriers),
    ]));
});

let ready: Promise<void> | undefined;
let stagingGeneration = 0;
const stagingPreparations = new Map<string, Promise<void>>();
export function initializeMessageStagingQueue() {
    ready ??= initializeMessageStagingPersistence().then(async () => {
        const restored = await restoreStagedAttachments(getMessageStagingNamespace(), messageStagingPersistence.load());
        messageStagingQueue.restore(restored.snapshot, restored.availableBlobUris);
        messageStagingQueue.refresh();
    });
    return ready;
}

export async function clearMessageStagingQueue() {
    stagingGeneration++;
    await initializeMessageStagingQueue();
    messageStagingQueue.clear();
    await clearMessageStagingStorage();
}

export async function stageSessionMessage(sessionId: string, text: string, attachments?: AttachmentPreview[], delivery: 'queue' | 'steer' = 'queue', context?: Pick<StagedMessage, 'draftText' | 'displayText' | 'annotations' | 'fileReference'>) {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    if (!session || !accountRuntimeCurrent()) throw new Error('Session unavailable');
    const modeMeta = resolveMessageModeMeta(session, state.settings);
    const selected = attachments?.map(a => ({ ...a }));
    const generation = stagingGeneration;
    // Persisting a large file must not let a later submission to the same
    // session overtake it. Controls and selections above remain call-time values.
    const previous = stagingPreparations.get(sessionId);
    const submission = (async () => {
        await previous;
        await initializeMessageStagingQueue();
        if (generation !== stagingGeneration || !storage.getState().sessions[sessionId] || !accountRuntimeCurrent()) throw new Error('Session unavailable');
        const namespace = getMessageStagingNamespace();
        let persisted = selected;
        if (selected?.length) {
            try { persisted = await persistStagedAttachments(namespace, selected); }
            catch { throw new StagedAttachmentSaveError('Attachment storage is unavailable'); }
        }
        const id = uuid();
        try {
            if (generation !== stagingGeneration || !accountRuntimeCurrent() || !storage.getState().sessions[sessionId]) throw new Error('Session unavailable');
            messageStagingQueue.enqueue({
                id, sessionId, text, draftText: context?.draftText, displayText: context?.displayText, annotations: context?.annotations, fileReference: context?.fileReference,
                attachments: persisted,
                modeMeta,
            });
        } catch (error) {
            await deleteStagedAttachments(namespace, persisted ?? []).catch(() => {});
            throw error;
        }
        if (delivery === 'steer') await messageStagingQueue.steer(id);
    })();
    const tail = submission.catch(() => {});
    stagingPreparations.set(sessionId, tail);
    try { await submission; }
    finally { if (stagingPreparations.get(sessionId) === tail) stagingPreparations.delete(sessionId); }
}
