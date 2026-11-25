import * as React from 'react';
import { useAllSessions } from '@/sync/storage';
import { projectConversationSessions, type ConversationSessionProjection } from '@/sync/conversationSession';

/** User-facing chats; native session discovery and execution keep using useAllSessions. */
export function useConversationSessions(): ConversationSessionProjection[] {
    const sessions = useAllSessions();
    return React.useMemo(() => projectConversationSessions(Object.fromEntries(sessions.map(session => [session.id, session])))
        .sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);
}
