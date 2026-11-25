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

type ConversationIndex = {
    inferredRoots: Map<string, string>;
    claimedIds: Set<string>;
    conflictingIds: Set<string>;
    conflictingRoots: Set<string>;
    chains: Map<string, string[]>;
};

/** Build once for list projection; ordinary sessions never cause predecessor walks. */
function buildConversationIndex(sessions: SessionMap, values = Object.values(sessions)): ConversationIndex {
    const roots = values.filter(session => session.id === getConversationRootSessionId(session)
        && session.metadata?.conversationActiveSessionId !== undefined);
    const claims = new Map<string, Set<string>>();
    const activeClaims = new Map<string, Set<string>>();
    const chains = new Map<string, string[]>();
    const conflictingRoots = new Set<string>();
    const conflictingIds = new Set<string>();
    for (const root of roots) {
        const activeId = root.metadata!.conversationActiveSessionId!;
        const owners = activeClaims.get(activeId) ?? new Set<string>();
        owners.add(root.id); activeClaims.set(activeId, owners);
    }
    for (const owners of activeClaims.values()) {
        if (owners.size > 1) owners.forEach(id => conflictingRoots.add(id));
    }
    for (const root of roots) {
        const chain: string[] = [];
        const seen = new Set<string>();
        let id = root.metadata!.conversationActiveSessionId!;
        for (;;) {
            const owners = claims.get(id) ?? new Set<string>();
            owners.add(root.id); claims.set(id, owners);
            const member = sessions[id];
            if (seen.has(id) || !member || member.id !== id || !member.metadata) break;
            seen.add(id); chain.push(id);
            if (id === root.id) { chains.set(root.id, chain); break; }
            if (member.metadata.conversationRootSessionId !== undefined && member.metadata.conversationRootSessionId !== root.id) {
                conflictingIds.add(id); conflictingRoots.add(root.id); break;
            }
            // Missing ownership is repairable only with positive machine/path
            // identity and a complete chain to this authoritative root.
            if (!root.metadata?.machineId || !root.metadata.path
                || member.metadata.machineId !== root.metadata.machineId || member.metadata.path !== root.metadata.path
                || member.metadata.conversationActiveSessionId !== undefined || !member.metadata.continuationOfSessionId) break;
            id = member.metadata.continuationOfSessionId;
        }
    }
    for (const owners of claims.values()) {
        if (owners.size > 1) owners.forEach(id => conflictingRoots.add(id));
    }
    const inferredRoots = new Map<string, string>();
    for (const [rootId, chain] of chains) {
        if (!conflictingRoots.has(rootId)) chain.forEach(id => inferredRoots.set(id, rootId));
    }
    return { inferredRoots, claimedIds: new Set(claims.keys()), conflictingIds, conflictingRoots, chains };
}

function resolveRootWithIndex(sessions: SessionMap, routeId: string, index: ConversationIndex): string | null {
    const requested = sessions[routeId];
    if (!requested || requested.id !== routeId || index.conflictingIds.has(routeId)) return null;
    const hint = requested.metadata?.conversationRootSessionId;
    const inferred = index.inferredRoots.get(routeId);
    const rootId = hint ?? inferred ?? routeId;
    if (hint === undefined && !inferred && requested.metadata?.conversationActiveSessionId === undefined
        && index.claimedIds.has(routeId)) return null;
    if (hint !== undefined && inferred !== undefined && hint !== inferred) return null;
    if (index.conflictingRoots.has(rootId)) return null;
    const root = sessions[rootId];
    if (!root || root.id !== rootId || getConversationRootSessionId(root) !== rootId) return null;
    const activeId = root.metadata?.conversationActiveSessionId ?? rootId;
    const active = sessions[activeId];
    if (!active || active.id !== activeId) return null;
    if (activeId !== rootId && ((active.metadata?.conversationRootSessionId ?? index.inferredRoots.get(activeId)) !== rootId
        || active.metadata?.conversationActiveSessionId !== undefined)) return null;
    for (const member of [requested, active]) {
        if (root.metadata?.machineId && member.metadata?.machineId !== root.metadata.machineId) return null;
        if (root.metadata?.path && member.metadata?.path !== root.metadata.path) return null;
    }
    return rootId;
}

/**
 * Resolve raw action ownership. Explicit membership also supports a reserved
 * candidate; missing hints require a unique, fully verified committed chain.
 * A plain continuation without a root active-pointer claim stays independent.
 */
export function resolveConversationRootSessionId(sessions: SessionMap, routeId: string): string | null {
    return resolveRootWithIndex(sessions, routeId, buildConversationIndex(sessions));
}

/** A claim is an availability guard, never sufficient authority to select a worker. */
export function hasConversationClaim(sessions: SessionMap, routeId: string): boolean {
    const metadata = sessions[routeId]?.metadata;
    if (metadata?.conversationRootSessionId !== undefined || metadata?.conversationActiveSessionId !== undefined
        || metadata?.conversationSwitch || metadata?.conversationDeletePlan) return true;
    const values = Object.values(sessions);
    if (buildConversationIndex(sessions, values).claimedIds.has(routeId)) return true;
    return values.some(session => session.metadata?.conversationSwitch?.targetSessionId === routeId
        || session.metadata?.conversationDeletePlan?.sessionIds.includes(routeId));
}

/** Missing or inconsistent pointers stay unavailable instead of selecting an old worker. */
export function resolveConversationSessionId(sessions: SessionMap, routeId: string): string | null {
    const rootId = resolveConversationRootSessionId(sessions, routeId);
    return rootId ? sessions[rootId].metadata?.conversationActiveSessionId ?? rootId : null;
}

export function isConversationSessionCurrent(sessions: SessionMap, sessionId: string): boolean {
    return resolveConversationSessionId(sessions, sessionId) === sessionId;
}

/** Complete committed execution chain, newest first; a new-session branch stops at its own root. */
export function getConversationSessionChain(sessions: SessionMap, sessionId: string): string[] | null {
    const index = buildConversationIndex(sessions);
    const rootId = resolveRootWithIndex(sessions, sessionId, index);
    if (!rootId) return null;
    if ((sessions[rootId].metadata?.conversationActiveSessionId ?? rootId) === rootId) return [rootId];
    return index.chains.get(rootId)?.slice() ?? null;
}

/** Stable root rows, live execution state, and untouched underlying encrypted histories. */
export function projectConversationSessions(sessions: SessionMap): ConversationSessionProjection[] {
    const values = Object.values(sessions);
    const index = buildConversationIndex(sessions, values);
    const groups = new Map<string, { root: Session; active: Session; ids: Set<string> }>();
    const resolvedRoots = new Map<string, string>();
    for (const session of values) {
        const rootId = resolveRootWithIndex(sessions, session.id, index);
        if (!rootId) continue;
        resolvedRoots.set(session.id, rootId);
        const root = sessions[rootId];
        const activeId = root.metadata?.conversationActiveSessionId ?? rootId;
        if (!root.metadata?.conversationActiveSessionId && !session.metadata?.conversationRootSessionId) continue;
        let group = groups.get(rootId);
        if (!group) {
            group = { root, active: sessions[activeId], ids: new Set([rootId]) };
            groups.set(rootId, group);
        }
        group.ids.add(session.id);
    }
    const represented = new Set<string>();
    const result: ConversationSessionProjection[] = [];
    for (const session of values) {
        const rootId = resolvedRoots.get(session.id);
        const group = rootId ? groups.get(rootId) : undefined;
        if (!rootId || !group || !group.ids.has(session.id)) { result.push(session); continue; }
        if (represented.has(rootId)) continue;
        represented.add(rootId);
        const { root, active, ids } = group;
        result.push({
            ...active,
            id: root.id,
            executionSessionId: active.id,
            conversationSessionIds: [...ids],
            createdAt: root.createdAt,
            lastMessageAt: active.lastMessageAt ?? root.lastMessageAt,
            lastUserMessageAt: active.lastUserMessageAt ?? root.lastUserMessageAt,
            metadata: active.metadata ? { ...active.metadata, summary: root.metadata?.summary } : null,
        });
    }
    return result;
}
