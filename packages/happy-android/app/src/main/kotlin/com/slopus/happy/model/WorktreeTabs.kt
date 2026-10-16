package com.slopus.happy.model

// utils/worktreeTabs.ts neighbouringTabId, utils/projectHomeList.ts
// locateProjectWorkspace and hooks/useProjectWorktree.ts
// useWorktreeTabSuccessor: which chat takes over a checkout's tab when one
// of its chats is archived.

/** neighbouringTabId: the tab before [sessionId], else the one after; null when it's alone or not there. */
fun neighbouringTabId(tabs: List<SessionRowData>, sessionId: String): String? {
    val index = tabs.indexOfFirst { it.id == sessionId }
    if (index == -1) return null
    return tabs.getOrNull(index - 1)?.id ?: tabs.getOrNull(index + 1)?.id
}

/** locateProjectWorkspace: the project and checkout whose chats include [sessionId]. */
fun locateProjectWorkspace(data: List<SessionListItem>, sessionId: String): Pair<ProjectGroupData, ProjectWorkspaceGroup>? {
    for (item in data) {
        if (item !is SessionListItem.ProjectItem) continue
        for (workspace in item.project.workspaces) {
            if (workspace.sessions.any { it.id == sessionId }) return item.project to workspace
        }
    }
    return null
}

/**
 * useWorktreeTabSuccessor: in the project layout, the neighbouring tab of
 * [sessionId]'s checkout, which takes the chat's place once it's archived.
 * Read before the archive, which takes the chat out of its checkout.
 */
fun worktreeTabSuccessor(data: List<SessionListItem>, sessionId: String, grouping: SessionListGrouping): String? {
    if (grouping != SessionListGrouping.Project) return null
    val (_, workspace) = locateProjectWorkspace(data, sessionId) ?: return null
    return neighbouringTabId(tabOrder(workspace.sessions), sessionId)
}
