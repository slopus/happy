import type { Session } from './storageTypes';

export type MessageSendMode = 'agent_queue' | 'interrupt' | 'server_pending';

export function chooseSubmitMode(opts: {
    configuredMode: MessageSendMode;
    session: Session | null;
}): MessageSendMode {
    const mode = opts.configuredMode;
    if (mode !== 'agent_queue') return mode;

    const session = opts.session;
    const supportsQueue = Boolean(session?.metadata?.messageQueueV1);
    if (!supportsQueue) return mode;

    const controlledByUser = Boolean(session?.agentState?.controlledByUser);
    const isBusy = Boolean(session?.thinking);
    const isOnline = session?.presence === 'online';
    const agentReady = Boolean(session && session.agentStateVersion > 0);

    // Prefer the metadata-backed queue when:
    // - terminal has control (can't safely inject into local stdin),
    // - the agent is busy (user may want to edit/remove before processing),
    // - the agent is not ready yet (direct sends can be missed because the agent does not replay backlog), or
    // - the machine is offline (queue gives reliable eventual processing once it reconnects).
    if (controlledByUser || isBusy || !isOnline || !agentReady) {
        return 'server_pending';
    }

    return mode;
}
