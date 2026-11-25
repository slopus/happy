import type { Session } from './storageTypes';

type SessionIdentity = Pick<Session, 'id' | 'metadata'>;
type SessionMap = Readonly<Record<string, Session>>;

/** Display projection only. Never pass this object to an execution RPC. */
export type ConversationSessionProjection = Session & {
    executionSessionId?: string;
    conversationSessionIds?: readonly string[];
};

export function getConversationRootSessionId(session: SessionIdentity): string {
    return session.metadata?.conversationRootSessionId ?? session.id;
}

/** Missing or inconsistent pointers stay unavailable instead of selecting an old worker. */
export function resolveConversationSessionId(sessions: SessionMap, routeId: string): string | null {
    const requested = sessions[routeId];
    if (!requested || requested.id !== routeId) return null;
    const rootId = getConversationRootSessionId(requested);
    const root = sessions[rootId];
    if (!root || root.id !== rootId || getConversationRootSessionId(root) !== rootId) return null;
    const activeId = root.metadata?.conversationActiveSessionId ?? rootId;
    const active = sessions[activeId];
    if (!active || active.id !== activeId) return null;
    if (activeId !== rootId && (active.metadata?.conversationRootSessionId !== rootId
        || active.metadata?.conversationActiveSessionId !== undefined)) return null;
    for (const member of [requested, active]) {
        if (root.metadata?.machineId && member.metadata?.machineId !== root.metadata.machineId) return null;
        if (root.metadata?.path && member.metadata?.path !== root.metadata.path) return null;
    }
    return activeId;
}

export function isConversationSessionCurrent(sessions: SessionMap, sessionId: string): boolean {
    return resolveConversationSessionId(sessions, sessionId) === sessionId;
}

/** Complete committed execution chain, newest first; a new-session branch stops at its own root. */
export function getConversationSessionChain(sessions: SessionMap, sessionId: string): string[] | null {
    const requested = sessions[sessionId];
    const activeId = resolveConversationSessionId(sessions, sessionId);
    if (!requested || !activeId) return null;
    const rootId = getConversationRootSessionId(requested);
    const chain: string[] = [];
    const seen = new Set<string>();
    let id = activeId;
    for (let count = 0; count <= Object.keys(sessions).length; count++) {
        if (seen.has(id) || !sessions[id] || resolveConversationSessionId(sessions, id) !== activeId) return null;
        seen.add(id); chain.push(id);
        if (id === rootId) return chain;
        const previous = sessions[id].metadata?.continuationOfSessionId;
        if (!previous) return null;
        id = previous;
    }
    return null;
}

/** Stable root rows, live execution state, and untouched underlying encrypted histories. */
export function projectConversationSessions(sessions: SessionMap): ConversationSessionProjection[] {
    const groups = new Map<string, { root: Session; active: Session; ids: string[] }>();
    for (const session of Object.values(sessions)) {
        const rootId = getConversationRootSessionId(session);
        const activeId = resolveConversationSessionId(sessions, session.id);
        if (!activeId) continue;
        const root = sessions[rootId];
        if (!root.metadata?.conversationActiveSessionId && !session.metadata?.conversationRootSessionId) continue;
        let group = groups.get(rootId);
        if (!group) {
            group = { root, active: sessions[activeId], ids: [rootId] };
            groups.set(rootId, group);
        }
        if (!group.ids.includes(session.id)) group.ids.push(session.id);
    }
    const represented = new Set<string>();
    const result: ConversationSessionProjection[] = [];
    for (const session of Object.values(sessions)) {
        const rootId = getConversationRootSessionId(session);
        const group = groups.get(rootId);
        if (!group || !group.ids.includes(session.id)) { result.push(session); continue; }
        if (represented.has(rootId)) continue;
        represented.add(rootId);
        const { root, active, ids } = group;
        result.push({
            ...active,
            id: root.id,
            executionSessionId: active.id,
            conversationSessionIds: ids,
            createdAt: root.createdAt,
            lastMessageAt: active.lastMessageAt ?? root.lastMessageAt,
            lastUserMessageAt: active.lastUserMessageAt ?? root.lastUserMessageAt,
            metadata: active.metadata ? { ...active.metadata, summary: root.metadata?.summary } : null,
        });
    }
    return result;
}
