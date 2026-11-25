import * as React from 'react';
import { useAllMachines } from '@/sync/storage';
import { useConversationSessions } from './useConversationSessions';
import type { Session } from '@/sync/storageTypes';
import { getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';

export interface SessionSearchResult {
    session: Session;
    /** Pre-computed display title (summary text or "New chat"). */
    title: string;
    /** Pre-computed path subtitle, relative to home when possible. */
    subtitle: string;
    /** Resolved machine display name, or null when unknown. */
    machineName: string | null;
}

/**
 * Local, synchronous full-list search over the user's sessions.
 *
 * Why local-only: session message bodies are end-to-end encrypted and only
 * decrypted into the store for sessions the user has actually opened, so a true
 * message full-text search is impossible client-side. Instead we match against
 * the metadata that is always present — session title (summary), project path
 * and machine name — which mirrors the "search by conversation title" UX of
 * other chat apps.
 *
 * Ranking: title matches rank above path/machine matches; within each tier the
 * store's existing recency order (newest `updatedAt` first) is preserved.
 */
export function useSessionSearch(query: string): SessionSearchResult[] {
    const sessions = useConversationSessions();
    const machines = useAllMachines({ includeOffline: true });

    // Map machineId -> display name so a query can match the machine a session
    // ran on (e.g. "mac-mini"), not just its title or path.
    const machineNameById = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const m of machines) {
            const name = m.metadata?.displayName || m.metadata?.host || m.id;
            map.set(m.id, name);
        }
        return map;
    }, [machines]);

    return React.useMemo(() => {
        const trimmed = query.trim().toLowerCase();
        if (trimmed.length === 0) {
            return [];
        }

        const titleMatches: SessionSearchResult[] = [];
        const otherMatches: SessionSearchResult[] = [];

        for (const session of sessions) {
            const title = getSessionName(session);
            const subtitle = getSessionSubtitle(session);
            const machineId = session.metadata?.machineId ?? null;
            const machineName = machineId ? machineNameById.get(machineId) ?? null : null;

            const titleHit = title.toLowerCase().includes(trimmed);
            const pathHit = subtitle.toLowerCase().includes(trimmed);
            const machineHit = !!machineName && machineName.toLowerCase().includes(trimmed);

            if (!titleHit && !pathHit && !machineHit) {
                continue;
            }

            const result: SessionSearchResult = { session, title, subtitle, machineName };
            if (titleHit) {
                titleMatches.push(result);
            } else {
                otherMatches.push(result);
            }
        }

        return [...titleMatches, ...otherMatches];
    }, [query, sessions, machineNameById]);
}
