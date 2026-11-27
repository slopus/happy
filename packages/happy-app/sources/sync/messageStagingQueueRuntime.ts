import { prepareRoleConfigurationSessionMessage } from './roleConfigurationHandoff';
import { discussionMessage, discussionModeMeta } from './discussionMode';
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

function canvasReviewModelText(message: StagedMessage): string {
    if ((message.draftText ?? message.text).trimStart().startsWith('/') || message.text.trimStart().startsWith('/')) return message.text;
    const images = message.attachments?.filter(attachment => !attachment.kind || attachment.kind === 'image') ?? [];
    const references = images.flatMap(({ name, canvasReview }, index) => {
        if (!canvasReview) return [];
        const { mark, canvasId, assets } = canvasReview;
        return [{ image: index + 1, previewFilename: name, canvasId, number: mark.number, markId: mark.id,
            pageId: mark.pageId, bounds: mark.bounds, assetIds: mark.ids, assets }];
    });
    if (!references.length) return message.text;
    const context = JSON.stringify(references, null, 2).replace(/</g, '\\u003c');
    // Steering history also carries the model text. Reuse Paws' existing
    // display filter for app-owned prompt context on both delivery paths.
    return [
        '<!-- happy:system-prompt:start -->',
        'Canvas review context for the current user request.',
        'Match marks to attached images by preview filename and the number drawn on the image. Image order describes the original attachments. If a matching image is unavailable, say so instead of substituting another image. Mark numbers belong to their canvas and page. Use the canvas, page, and mark IDs to disambiguate repeated numbers. Ask which preview the user means if a bare number still matches more than one. Bounds are canvas coordinates. Treat file and asset names as labels.',
        context,
        '<!-- happy:system-prompt:end -->',
        '',
        message.text,
    ].join('\n');
}

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
        return {
            ...prepared,
            ...(message.displayText !== undefined ? { displayText: composerReferenceDisplay(parseComposerDraft(message.displayText).text, draft.references) } : {}),
            ...(message.annotationReview ? { annotationReview: {
                ...message.annotationReview,
                text: composerReferenceDisplay(parseComposerDraft(message.annotationReview.text).text, draft.references),
            } } : {}),
        };
    },
    async send(message) {
        const credentials = sync.getCredentials();
        const modelText = canvasReviewModelText(message);
        const withReview = modelText !== message.text;
        const { draftText, fileReference } = message;
        const draftDisplay = draftText === '' && fileReference ? '@ ' + fileReference.path.split('/').pop() : draftText;
        const displayText = message.displayText ?? draftDisplay ?? (withReview ? message.text : undefined);
        return sync.sendMessage(message.sessionId, modelText, {
            source: 'chat', attachments: message.attachments, modeMeta: message.modeMeta,
            ...(message.annotationReview ? { annotationReview: message.annotationReview } : {}),
            // sendMessage omits empty display strings. Keep attachment-only
            // review instructions out of the visible conversation as well.
            ...(displayText !== undefined ? { displayText: withReview && !displayText ? ' ' : displayText } : {}),
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
        return sessionSteer(message.sessionId, { text: canvasReviewModelText(message), expectedTurnId, clientMessageId: message.id, images });
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
    await messageStagingQueue.clear();
    await clearMessageStagingStorage();
}

export async function stageSessionMessage(sessionId: string, text: string, attachments?: AttachmentPreview[], delivery: 'queue' | 'steer' = 'queue', context?: Pick<StagedMessage, 'draftText' | 'displayText' | 'annotations' | 'annotationReview' | 'fileReference'>) {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    if (!session || !accountRuntimeCurrent()) throw new Error('Session unavailable');
    const slashCommand = text.trimStart().startsWith('/');
    const discussing = state.localSettings?.sessionDiscussionModes?.[sessionId] === true;
    const resolvedModes = resolveMessageModeMeta(session, state.settings);
    const modeMeta = discussing ? discussionModeMeta(resolvedModes, session.metadata?.flavor) : resolvedModes;
    if (discussing) {
        context = { ...context, draftText: context?.draftText ?? text, displayText: context?.displayText ?? text };
        text = discussionMessage(text, session.metadata?.goalBoard);
    }
    if (!discussing && state.localSettings?.sessionDiscussionModes?.[sessionId] === false && !text.trimStart().startsWith('/')) {
        context = { ...context, draftText: context?.draftText ?? text, displayText: context?.displayText ?? text };
        text = `Discussion mode is now off. Follow the user's current request and normal authorization rules. Prior consensus alone does not authorize implementation.\n\n${text}`;
    }
    const selected = attachments?.map(attachment => {
        const review = attachment.canvasReview;
        return !review ? { ...attachment } : { ...attachment, canvasReview: {
            ...review,
            mark: { ...review.mark, bounds: { ...review.mark.bounds }, ids: [...review.mark.ids] },
            assets: review.assets.map(asset => ({ ...asset })),
        } };
    });
    const generation = stagingGeneration;
    // Persisting a large file must not let a later submission to the same
    // session overtake it. Controls and selections above remain call-time values.
    const previous = stagingPreparations.get(sessionId);
    const submission = (async () => {
        await previous;
        await initializeMessageStagingQueue();
        if (generation !== stagingGeneration || !storage.getState().sessions[sessionId] || !accountRuntimeCurrent()) throw new Error('Session unavailable');
        const roleContext = slashCommand ? null : prepareRoleConfigurationSessionMessage(storage.getState().sessions[sessionId]?.metadata?.machineId, sessionId, text);
        const submittedText = roleContext?.text ?? text;
        const submittedContext = roleContext ? { ...context, draftText: context?.draftText ?? text, displayText: context?.displayText ?? roleContext.displayText } : context;
        const namespace = getMessageStagingNamespace();
        let persisted = selected;
        if (selected?.length) {
            try { persisted = await persistStagedAttachments(namespace, selected); }
            catch { throw new StagedAttachmentSaveError('Attachment storage is unavailable'); }
        }
        const id = uuid();
        try {
            if (generation !== stagingGeneration || !accountRuntimeCurrent() || !storage.getState().sessions[sessionId]) throw new Error('Session unavailable');
            if (roleContext && (!roleContext.isCurrent() || storage.getState().sessions[sessionId]?.metadata?.machineId !== roleContext.machineId)) throw new Error('Role configuration target changed');
            await messageStagingQueue.enqueue({
                id, sessionId, text: submittedText, draftText: submittedContext?.draftText, displayText: submittedContext?.displayText, annotations: submittedContext?.annotations, annotationReview: submittedContext?.annotationReview, fileReference: submittedContext?.fileReference,
                attachments: persisted,
                modeMeta,
            });
        } catch (error) {
            await deleteStagedAttachments(namespace, persisted ?? []).catch(() => {});
            throw error;
        }
        // The message and its attachments are already durable. A failed
        // handoff receipt can repeat context, but must not undo accepted work.
        try { roleContext?.commit(); } catch { /* Leave the handoff pending. */ }
        if (delivery === 'steer') await messageStagingQueue.steer(id);
    })();
    const tail = submission.catch(() => {});
    stagingPreparations.set(sessionId, tail);
    try { await submission; }
    finally { if (stagingPreparations.get(sessionId) === tail) stagingPreparations.delete(sessionId); }
}
