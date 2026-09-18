import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { storage, useSetting } from '@/sync/storage';
import { usePendingChatRecords } from '@/sync/pendingChats';
import { locateProjectWorkspace, tabOrder } from '@/utils/projectHomeList';
import { neighbouringTabId, resolveWorktreeTabs } from '@/utils/worktreeTabs';

export interface ProjectWorktreeSummary {
    projectName: string;
    /** Null for the project's own checkout, which goes by its branch. */
    workspaceName: string | null;
    tabCount: number;
}

const NONE = { found: false, projectName: '', workspaceName: null, tabCount: 0 } as const;

/**
 * What the session screen's header says about the checkout a chat runs in,
 * while the home list is grouped by project — the layout where the list stops
 * at checkouts and chats live as their tabs. Null under the flat list, and for
 * chats outside a project, which keep the plain single-chat header.
 *
 * Selects primitives only, so a busy store (an agent streaming a reply rebuilds
 * the session list many times a second) re-renders the screen only when the
 * checkout's name or tab count actually changes.
 */
export function useProjectWorktreeSummary(sessionId: string): ProjectWorktreeSummary | null {
    const enabled = useSetting('sessionListGrouping') === 'project';
    // A chat being opened is a tab the strip already draws, and a chat whose
    // session has just arrived is only one tab even while it is briefly both.
    // The count is resolved the same way the strip is, or the header contradicts
    // what is on screen right under it.
    const pendingRecords = usePendingChatRecords();
    const summary = storage(useShallow((state) => {
        if (!enabled) return NONE;
        const found = locateProjectWorkspace(state.sessionListViewData, sessionId);
        if (!found) return NONE;
        const sessions = found.workspace.sessions;
        const resolved = resolveWorktreeTabs({
            tabs: sessions,
            pending: Object.values(pendingRecords)
                .filter((chat) => (
                    chat.status === 'starting'
                    && sessions.some((session) => session.id === chat.anchorSessionId)
                ))
                .sort((a, b) => a.createdAt - b.createdAt),
        });
        return {
            found: true,
            projectName: found.project.name,
            workspaceName: found.workspace.id === '' ? null : found.workspace.name ?? found.workspace.id,
            tabCount: resolved.tabs.length + resolved.pending.length,
        };
    }));

    return React.useMemo(() => (
        summary.found
            ? { projectName: summary.projectName, workspaceName: summary.workspaceName, tabCount: summary.tabCount }
            : null
    ), [summary.found, summary.projectName, summary.workspaceName, summary.tabCount]);
}

/**
 * Which chat the screen should fall back to if this one is archived.
 *
 * Grouped by project, a chat is one tab of its checkout, and closing a tab
 * leaves you on the strip rather than back at the top of the app. Null when
 * there is no strip to stay in — the flat list, a bot, or the last chat in its
 * checkout — and the caller leaves the chat screen the way it always did.
 *
 * Read while the chat is still there. Archiving takes it out of the checkout,
 * and asking afterwards finds nothing left to be a neighbour of.
 */
export function useWorktreeTabSuccessor(sessionId: string): string | null {
    const enabled = useSetting('sessionListGrouping') === 'project';
    return storage((state) => {
        if (!enabled) return null;
        const found = locateProjectWorkspace(state.sessionListViewData, sessionId);
        if (!found) return null;
        return neighbouringTabId(tabOrder(found.workspace.sessions), sessionId);
    });
}
