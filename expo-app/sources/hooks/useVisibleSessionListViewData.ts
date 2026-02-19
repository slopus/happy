import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';
import { useCollapsedSections } from './useCollapsedSections';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const collapsedSections = useCollapsedSections();

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        // If hiding inactive sessions, filter them out completely
        if (hideInactiveSessions) {
            const filtered: SessionListViewItem[] = [];
            let pendingProjectGroup: SessionListViewItem | null = null;

            for (const item of data) {
                if (item.type === 'project-group') {
                    pendingProjectGroup = item;
                    continue;
                }

                if (item.type === 'session') {
                    if (item.session.active) {
                        if (pendingProjectGroup) {
                            filtered.push(pendingProjectGroup);
                            pendingProjectGroup = null;
                        }
                        filtered.push(item);
                    }
                    continue;
                }

                pendingProjectGroup = null;

                if (item.type === 'active-sessions') {
                    filtered.push(item);
                }
            }

            return filtered;
        }

        // Handle section collapsing
        const filtered: SessionListViewItem[] = [];
        let currentCollapsedSectionId: string | null = null;

        for (const item of data) {
            if (item.type === 'header') {
                // Always include headers (they contain the collapse toggle)
                filtered.push(item);

                // Check if this section is collapsed
                if (item.collapsible && item.sectionId && collapsedSections.has(item.sectionId)) {
                    currentCollapsedSectionId = item.sectionId;
                } else {
                    currentCollapsedSectionId = null;
                }
                continue;
            }

            if (item.type === 'session') {
                // Skip sessions if current section is collapsed
                if (currentCollapsedSectionId) {
                    continue;
                }
                filtered.push(item);
                continue;
            }

            if (item.type === 'project-group') {
                // Skip project groups if current section is collapsed
                if (currentCollapsedSectionId) {
                    continue;
                }
                filtered.push(item);
                continue;
            }

            // active-sessions and other types: always include, reset collapsed state
            currentCollapsedSectionId = null;
            filtered.push(item);
        }

        return filtered;
    }, [data, hideInactiveSessions, collapsedSections]);
}
