import { isSessionArchived } from '@/utils/sessionLifecycle';
import type { Session } from './storageTypes';

/** Personal owns a conversation domain; sessions are only its encrypted transport. */
export function isPersonalAgentConversation(session: { metadata?: { flavor?: string | null } | null }): boolean {
    return session.metadata?.flavor === 'personal';
}

export function selectPersonalAgentConversation(sessions: readonly Session[], preferredId: string | null): string | null {
    // A persisted thread may be outside the currently loaded history page. Open
    // that exact ID instead of treating a missing list row as a deleted thread.
    if (preferredId) return preferredId;
    return [...sessions].filter(session => isPersonalAgentConversation(session) && !isSessionArchived(session))
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0]?.id ?? null;
}

export const PERSONAL_AGENT_NAME_MAX_LENGTH = 60;
export const PERSONAL_AGENT_AVATAR_MAX_LENGTH = 180_000;

export function personalAgentDisplayName(name: string | null | undefined): string {
    return name?.trim().slice(0, PERSONAL_AGENT_NAME_MAX_LENGTH) || 'Paws';
}

export function isPersonalAgentAvatar(value: string): boolean {
    return value.length <= PERSONAL_AGENT_AVATAR_MAX_LENGTH
        && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
