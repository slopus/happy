import * as React from 'react';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';

export function useLinkedSessions(source: string, resourceId: string): Session[] {
    const sessions = storage((s) => s.sessions);

    return React.useMemo(() => {
        return Object.values(sessions)
            .filter((s) => {
                const ctx = s.metadata?.externalContext;
                return ctx?.source === source && ctx?.resourceId === resourceId;
            })
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    }, [sessions, source, resourceId]);
}
