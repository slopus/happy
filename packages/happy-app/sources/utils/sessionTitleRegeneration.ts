import type { Metadata, Session } from '@/sync/storageTypes';
import { isRetiredSession } from '@/sync/retiredSessions';

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isKnownTitleRegenerationProvider(metadata: Metadata): boolean {
    return metadata.flavor === 'claude'
        || metadata.flavor === 'codex'
        || nonEmpty(metadata.claudeSessionId)
        || nonEmpty(metadata.codexThreadId);
}

export function canRegenerateSessionTitle(session: Session): boolean {
    if (isRetiredSession(session)) return false;
    if (session.presence !== 'online' || !session.metadata) {
        return false;
    }

    const capability = session.metadata.capabilities?.regenerateTitle;
    if (capability !== undefined) {
        return capability;
    }

    return isKnownTitleRegenerationProvider(session.metadata);
}
