import * as React from 'react';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';

function normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '').toLowerCase();
}

export function useLinkedSessions(
    source: string,
    resourceId: string,
    resourceType?: string,
    sourceUrl?: string,
): Session[] {
    const sessions = storage((s) => s.sessions);
    const normalizedSourceUrl = sourceUrl ? normalizeUrl(sourceUrl) : undefined;

    return React.useMemo(() => {
        return Object.values(sessions)
            .filter((s) => {
                const ctx = s.metadata?.externalContext;
                if (!ctx || ctx.source !== source || ctx.resourceId !== resourceId) return false;
                if (resourceType && ctx.resourceType !== resourceType) return false;
                if (normalizedSourceUrl && (!ctx.sourceUrl || normalizeUrl(ctx.sourceUrl) !== normalizedSourceUrl)) return false;
                return true;
            })
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    }, [sessions, source, resourceId, resourceType, normalizedSourceUrl]);
}
