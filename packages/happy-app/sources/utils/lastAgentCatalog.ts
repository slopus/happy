import type { Session } from '@/sync/storageTypes';

export interface AgentCatalog {
    models: NonNullable<Session['metadata']>['models'];
    operatingModes: NonNullable<Session['metadata']>['operatingModes'];
    currentModelCode: string | null;
    currentOperatingModeCode: string | null;
}

/**
 * The model and mode catalog an agent published over ACP in its last session.
 *
 * An ACP agent has no catalog to offer until it opens a session and reports one
 * — OpenCode sends its models and modes as configOptions on session/new. That
 * leaves the new-chat composer with nothing truthful to show for any agent
 * whose lists are not hardcoded, and the alternative is showing the wrong
 * vendor's models or a lone "default" that hides the choice until the chat has
 * already started.
 *
 * Reusing what the same agent reported last on the same machine is the closest
 * honest answer available before the session exists. It can be stale — the
 * agent's real catalog still wins once the session reports it.
 */
export function findLastAgentCatalog(
    sessions: Record<string, Session> | null | undefined,
    flavor: string | null | undefined,
    machineId?: string | null,
): AgentCatalog | null {
    if (!flavor || !sessions) return null;

    let best: Session | null = null;
    for (const session of Object.values(sessions)) {
        const metadata = session?.metadata;
        if (!metadata || metadata.flavor !== flavor) continue;
        // A catalog from another computer can name models this one cannot run.
        if (machineId && metadata.machineId && metadata.machineId !== machineId) continue;
        if (!metadata.models || metadata.models.length === 0) continue;
        if (!best || (session.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = session;
    }
    if (!best?.metadata) return null;

    return {
        models: best.metadata.models,
        operatingModes: best.metadata.operatingModes,
        currentModelCode: best.metadata.currentModelCode ?? null,
        currentOperatingModeCode: best.metadata.currentOperatingModeCode ?? null,
    };
}
