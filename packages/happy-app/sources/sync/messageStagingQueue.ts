import { DISCUSSION_INSTRUCTIONS } from './discussionMode';
import type { MessageAnnotation } from '@/components/annotations/annotationDraft';
import type { AttachmentPreview } from './attachmentTypes';
import type { MessageModeMeta } from './messageMeta';

export class StagedAttachmentSaveError extends Error {
    name = 'StagedAttachmentSaveError';
}

export type StagedMessage = {
    id: string;
    sessionId: string;
    text: string;
    draftText?: string;
    displayText?: string;
    /** Frozen before the first transport attempt, including ACK-loss retries. */
    preparedText?: string;
    annotations?: readonly MessageAnnotation[];
    fileReference?: { path: string; hash: string; quote?: string };
    attachments?: AttachmentPreview[];
    modeMeta: MessageModeMeta;
    status: 'queued' | 'sending' | 'failed';
    attachmentsExpired?: boolean;
    expiredAttachmentIds?: string[];
    deliveryUncertain?: boolean;
};

export type StagingSession = {
    connected: boolean;
    state: 'running' | 'permission_required' | 'idle' | 'completed' | 'failed';
    turnId?: string;
    terminal?: boolean;
    supportsSteer?: boolean;
};

/** Keep unavailable actions out of both the view and the dispatcher. */
export function canSendStagedMessageNow(message: Pick<StagedMessage, 'text' | 'attachmentsExpired'>, session?: StagingSession): boolean {
    if (!session?.connected || message.attachmentsExpired) return false;
    const busy = session.state === 'running' || session.state === 'permission_required';
    return !busy || (session.supportsSteer === true && !!session.turnId && !message.text.trimStart().startsWith('/') && !message.text.startsWith(DISCUSSION_INSTRUCTIONS));
}

type TurnBarrier = { turnId?: string; sawRunning: boolean };
export type StagingSnapshot = {
    messages: StagedMessage[];
    barriers: Record<string, TurnBarrier>;
};

/** One dispatcher per app runtime, independent of the currently viewed route.
 * A successful submission is not a completed turn: retain a barrier until the
 * runner has started and finished that turn (or reports a new completed ID).
 */
function recoveredMessage(message: StagedMessage, availableBlobUris: ReadonlySet<string> = new Set()): StagedMessage {
    const expiredAttachmentIds = message.attachments?.filter(attachment => attachment.uri.startsWith('blob:') && !availableBlobUris.has(attachment.uri)).map(attachment => attachment.id) ?? [];
    const previouslyExpired = expiredStagedAttachments(message);
    const unresolvedPreviousFlag = message.attachmentsExpired && (!previouslyExpired.length || previouslyExpired.some(attachment => !availableBlobUris.has(attachment.uri)));
    const attachmentsExpired = expiredAttachmentIds.length > 0 || unresolvedPreviousFlag;
    return {
        ...message,
        attachmentsExpired: attachmentsExpired || undefined,
        expiredAttachmentIds: attachmentsExpired ? expiredAttachmentIds : undefined,
        status: message.status === 'sending' || attachmentsExpired ? 'failed' : message.status,
        ...(message.status === 'sending' ? { deliveryUncertain: true } : {}),
    };
}

export function expiredStagedAttachments(message: StagedMessage): AttachmentPreview[] {
    if (!message.attachmentsExpired) return [];
    return message.attachments?.filter(attachment => message.expiredAttachmentIds
        ? message.expiredAttachmentIds.includes(attachment.id)
        : attachment.uri.startsWith('blob:')) ?? [];
}

export function availableStagedAttachments(message: StagedMessage): AttachmentPreview[] {
    const expired = new Set(expiredStagedAttachments(message).map(attachment => attachment.id));
    return message.attachments?.filter(attachment => !expired.has(attachment.id)) ?? [];
}

export function createMessageStagingQueue(deps: {
    load: () => StagingSnapshot;
    save: (snapshot: StagingSnapshot) => void | Promise<void>;
    session: (id: string) => StagingSession | undefined;
    prepare?: (message: StagedMessage) => Promise<{ text: string; displayText?: string } | undefined>;
    send: (message: StagedMessage) => Promise<unknown>;
    steer: (message: StagedMessage, expectedTurnId: string) => Promise<unknown>;
}) {
    const restored = deps.load();
    let snapshot: StagingSnapshot = {
        ...restored,
        // A process may have died after acceptance. Never silently resend an
        // ambiguous submission; let the user inspect history and retry it.
        messages: restored.messages.map(message => recoveredMessage(message)),
    };
    const listeners = new Set<() => void>();
    const locks = new Set<string>();
    let generation = 0;

    let commitTail: Promise<void> | undefined;
    const isPromise = (value: unknown): value is Promise<void> => !!value && typeof (value as Promise<void>).then === 'function';
    function commit(update: (current: StagingSnapshot) => StagingSnapshot): void | Promise<void> {
        const owner = generation;
        const run = () => {
            if (owner !== generation) throw new Error('Queue owner changed');
            const next = update(snapshot);
            const publish = () => {
                if (owner !== generation) throw new Error('Queue owner changed');
                snapshot = next;
                for (const listener of listeners) listener();
            };
            const saved = deps.save(next);
            if (isPromise(saved)) return saved.then(publish);
            publish();
        };
        const result = commitTail ? commitTail.then(run) : run();
        if (!isPromise(result)) return;
        const tail = result.catch(() => {});
        commitTail = tail;
        void tail.then(() => { if (commitTail === tail) commitTail = undefined; });
        return result;
    }
    function afterCommit<T>(result: void | Promise<void>, next: () => T): T | Promise<T> {
        return isPromise(result) ? result.then(next) : next();
    }

    async function dispatch(message: StagedMessage, guide: boolean) {
        const sid = message.sessionId;
        if (locks.has(sid) || !deps.session(sid)?.connected) return;
        if (guide && !canSendStagedMessageNow(message, deps.session(sid))) return;
        locks.add(sid);
        const owner = generation;
        let submitted = false;
        let barrierCreated = false;
        const previousBarrier = snapshot.barriers[sid];
        try {
            await commit(state => {
                const current = state.messages.find(m => m.id === message.id);
                if (!current || current.status === 'sending') throw new Error('Message is no longer available');
                message = current;
                return { ...state, messages: state.messages.map(m => m.id === message.id ? { ...m, status: 'sending' } : m) };
            });
            if (owner !== generation) return;
            if (message.preparedText === undefined && deps.prepare) {
                const prepared = await deps.prepare(message);
                if (owner !== generation) return;
                if (prepared) {
                    message = { ...message, preparedText: prepared.text, displayText: prepared.displayText ?? message.displayText };
                    await commit(state => ({ ...state, messages: state.messages.map(m => m.id === message.id ? { ...m, preparedText: message.preparedText, displayText: message.displayText } : m) }));
                }
            }
            const delivery = message.preparedText === undefined ? message : { ...message, text: message.preparedText };
            const active = deps.session(sid);
            if (guide && (message.text.startsWith(DISCUSSION_INSTRUCTIONS) || !active?.supportsSteer || !active.turnId)) throw new Error('Native steering unavailable');
            // Native steering joins the existing turn. Its completion releases
            // the barrier; it does not produce another turn/started event.
            await commit(state => ({ ...state, barriers: { ...state.barriers, [sid]: { turnId: active?.turnId, sawRunning: guide } } }));
            barrierCreated = true;
            if (guide) await deps.steer(delivery, active!.turnId!);
            else await deps.send(delivery);
            submitted = true;
            if (owner !== generation) return;
            await commit(state => ({ ...state, messages: state.messages.filter(m => m.id !== message.id) }));
        } catch {
            if (owner === generation) {
                const barriers = { ...snapshot.barriers };
                if (barrierCreated && !submitted) {
                    if (previousBarrier) barriers[sid] = previousBarrier;
                    else delete barriers[sid];
                }
                try {
                    await commit(state => ({ ...state, barriers, messages: state.messages.map(m => m.id === message.id ? { ...m, status: 'failed', ...(submitted ? { deliveryUncertain: true } : {}) } : m) }));
                } catch {
                    snapshot = { ...snapshot, messages: snapshot.messages.map(m => m.id === message.id ? { ...m, status: 'failed', deliveryUncertain: true } : m) };
                    for (const listener of listeners) listener();
                }
            }
        } finally {
            locks.delete(sid);
            if (owner === generation) refresh();
        }
    }

    function refresh() {
        for (const sid of new Set([...snapshot.messages.map(m => m.sessionId), ...Object.keys(snapshot.barriers)])) {
            const session = deps.session(sid);
            if (!session?.connected) continue;
            const barrier = snapshot.barriers[sid];
            if (barrier) {
                if (session.state === 'running' || session.state === 'permission_required') {
                    // A delayed running update for the previous turn does
                    // not prove the newly submitted turn has started.
                    // Codex reports pending input as busy before turn/start.
                    // That is not proof that this submission's turn started.
                    const started = session.turnId
                        ? session.turnId !== barrier.turnId
                        : !session.supportsSteer;
                    if (!barrier.sawRunning && started) {
                        const saved = commit(state => ({ ...state, barriers: { ...state.barriers, [sid]: { ...barrier, sawRunning: true } } }));
                        if (isPromise(saved)) void saved.catch(() => {});
                    }
                    continue;
                }
                if (!barrier.sawRunning && !((session.terminal || session.state === 'completed') && session.turnId && session.turnId !== barrier.turnId)) continue;
                const barriers = { ...snapshot.barriers };
                delete barriers[sid];
                const saved = commit(state => { const next = { ...state.barriers }; delete next[sid]; return { ...state, barriers: next }; });
                if (isPromise(saved)) { void saved.then(refresh, () => {}); continue; }
            }
            if (session.state !== 'idle' && session.state !== 'completed') continue;
            if (locks.has(sid)) continue;
            const first = snapshot.messages.find(m => m.sessionId === sid);
            if (first?.status === 'queued') void dispatch(first, false);
        }
    }

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        refresh,
        restore(value: StagingSnapshot, availableBlobUris?: ReadonlySet<string>) {
            generation++;
            snapshot = { ...value, messages: value.messages.map(message => recoveredMessage(message, availableBlobUris)) };
            for (const listener of listeners) listener();
        },
        enqueue(message: Omit<StagedMessage, 'status'>) {
            let retryFailedTurn = false;
            return afterCommit(commit(state => {
                retryFailedTurn = deps.session(message.sessionId)?.state === 'failed'
                    && !state.messages.some(m => m.sessionId === message.sessionId) && !state.barriers[message.sessionId];
                return { ...state, messages: [...state.messages, { ...message, status: 'queued' }] };
            }), () => {
                if (retryFailedTurn) { void dispatch({ ...message, status: 'queued' }, false); return; }
                refresh();
            });
        },
        remove(id: string) {
            return afterCommit(commit(state => ({ ...state, messages: state.messages.filter(m => m.id !== id || m.status === 'sending') })), refresh);
        },
        take(id: string) {
            let taken: StagedMessage | undefined;
            return afterCommit(commit(state => {
                taken = state.messages.find(m => m.id === id && m.status !== 'sending');
                return taken ? { ...state, messages: state.messages.filter(m => m.id !== id) } : state;
            }), () => { refresh(); return taken; });
        },
        steer(id: string) {
            const message = snapshot.messages.find(m => m.id === id);
            if (!message || message.status === 'sending' || message.attachmentsExpired) return Promise.resolve();
            const session = deps.session(message.sessionId);
            // Commands execute between turns in the CLI. A queued command
            // must never be inserted into the current model turn as prose.
            if (message.text.trimStart().startsWith('/')
                && (session?.state === 'running' || session?.state === 'permission_required')) return Promise.resolve();
            return dispatch(message, session?.state === 'running' || session?.state === 'permission_required');
        },
        clear() {
            generation++;
            return commit(() => ({ messages: [], barriers: {} }));
        },
    };
}
