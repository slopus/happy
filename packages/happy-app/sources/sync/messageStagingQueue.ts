import type { AttachmentPreview } from './attachmentTypes';
import type { MessageModeMeta } from './messageMeta';

export type StagedMessage = {
    id: string;
    sessionId: string;
    text: string;
    attachments?: AttachmentPreview[];
    modeMeta: MessageModeMeta;
    status: 'queued' | 'sending' | 'failed';
};

export type StagingSession = {
    connected: boolean;
    state: 'running' | 'permission_required' | 'idle' | 'completed' | 'failed';
    turnId?: string;
    terminal?: boolean;
    supportsSteer?: boolean;
};

/** Keep unavailable actions out of both the view and the dispatcher. */
export function canSendStagedMessageNow(message: Pick<StagedMessage, 'text'>, session?: StagingSession): boolean {
    if (!session?.connected) return false;
    const busy = session.state === 'running' || session.state === 'permission_required';
    return !busy || (session.supportsSteer === true && !!session.turnId && !message.text.trimStart().startsWith('/'));
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
export function createMessageStagingQueue(deps: {
    load: () => StagingSnapshot;
    save: (snapshot: StagingSnapshot) => void;
    session: (id: string) => StagingSession | undefined;
    send: (message: StagedMessage) => Promise<unknown>;
    steer: (message: StagedMessage, expectedTurnId: string) => Promise<unknown>;
}) {
    const restored = deps.load();
    let snapshot: StagingSnapshot = {
        ...restored,
        // A process may have died after acceptance. Never silently resend an
        // ambiguous submission; let the user inspect history and retry it.
        messages: restored.messages.map(m => m.status === 'sending' ? { ...m, status: 'failed' } : m),
    };
    const listeners = new Set<() => void>();
    const locks = new Set<string>();
    let generation = 0;

    function commit(next: StagingSnapshot) {
        deps.save(next);
        snapshot = next;
        for (const listener of listeners) listener();
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
            commit({ ...snapshot, messages: snapshot.messages.map(m => m.id === message.id ? { ...m, status: 'sending' } : m) });
            if (owner !== generation) return;
            const active = deps.session(sid);
            if (guide && (!active?.supportsSteer || !active.turnId)) throw new Error('Native steering unavailable');
            // Native steering joins the existing turn. Its completion releases
            // the barrier; it does not produce another turn/started event.
            commit({ ...snapshot, barriers: { ...snapshot.barriers, [sid]: { turnId: active?.turnId, sawRunning: guide } } });
            barrierCreated = true;
            if (guide) await deps.steer(message, active!.turnId!);
            else await deps.send(message);
            submitted = true;
            if (owner !== generation) return;
            commit({ ...snapshot, messages: snapshot.messages.filter(m => m.id !== message.id) });
        } catch {
            if (owner === generation) {
                const barriers = { ...snapshot.barriers };
                if (barrierCreated && !submitted) {
                    if (previousBarrier) barriers[sid] = previousBarrier;
                    else delete barriers[sid];
                }
                commit({ ...snapshot, barriers, messages: snapshot.messages.map(m => m.id === message.id ? { ...m, status: 'failed' } : m) });
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
                        commit({ ...snapshot, barriers: { ...snapshot.barriers, [sid]: { ...barrier, sawRunning: true } } });
                    }
                    continue;
                }
                if (!barrier.sawRunning && !((session.terminal || session.state === 'completed') && session.turnId && session.turnId !== barrier.turnId)) continue;
                const barriers = { ...snapshot.barriers };
                delete barriers[sid];
                commit({ ...snapshot, barriers });
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
        restore(value: StagingSnapshot) {
            generation++;
            snapshot = { ...value, messages: value.messages.map(m => m.status === 'sending' ? { ...m, status: 'failed' } : m) };
            for (const listener of listeners) listener();
        },
        enqueue(message: Omit<StagedMessage, 'status'>) {
            const retryFailedTurn = deps.session(message.sessionId)?.state === 'failed'
                && !snapshot.messages.some(m => m.sessionId === message.sessionId)
                && !snapshot.barriers[message.sessionId];
            commit({ ...snapshot, messages: [...snapshot.messages, { ...message, status: 'queued' }] });
            if (retryFailedTurn) { void dispatch({ ...message, status: 'queued' }, false); return; }
            refresh();
        },
        remove(id: string) {
            if (snapshot.messages.find(m => m.id === id)?.status === 'sending') return;
            commit({ ...snapshot, messages: snapshot.messages.filter(m => m.id !== id) });
            refresh();
        },
        take(id: string) {
            const message = snapshot.messages.find(m => m.id === id);
            if (!message || message.status === 'sending') return undefined;
            commit({ ...snapshot, messages: snapshot.messages.filter(m => m.id !== id) });
            refresh();
            return message;
        },
        steer(id: string) {
            const message = snapshot.messages.find(m => m.id === id);
            if (!message || message.status === 'sending') return Promise.resolve();
            const session = deps.session(message.sessionId);
            // Commands execute between turns in the CLI. A queued command
            // must never be inserted into the current model turn as prose.
            if (message.text.trimStart().startsWith('/')
                && (session?.state === 'running' || session?.state === 'permission_required')) return Promise.resolve();
            return dispatch(message, session?.state === 'running' || session?.state === 'permission_required');
        },
        clear() {
            generation++;
            commit({ messages: [], barriers: {} });
        },
    };
}
