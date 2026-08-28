import type { AgentState, Session } from './storageTypes';

export function getAgentStateDecryptFallback(
    sessions: Record<string, Pick<Session, 'agentState'> | undefined>,
    sessionId: string,
): AgentState {
    return sessions[sessionId]?.agentState ?? {};
}
