import type { NewSessionDraft } from './persistence';

/**
 * Pure migration function: resets a corrupted `agentType` back to 'claude'.
 *
 * A bug in the availableAgents override effect persisted fallback agent types
 * (e.g. 'openclaw', 'gemini') to MMKV when Claude was temporarily unavailable.
 * This migration resets the stored agentType to the intended default ('claude')
 * so existing devices recover automatically.
 *
 * Returns null if the input is null (no draft stored).
 */
export function migrateNewSessionDraftAgentType(
    draft: NewSessionDraft | null,
): NewSessionDraft | null {
    if (draft === null) {
        return null;
    }
    if (draft.agentType !== 'claude') {
        return { ...draft, agentType: 'claude' };
    }
    return draft;
}
