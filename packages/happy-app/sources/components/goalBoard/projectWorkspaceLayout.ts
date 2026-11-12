import { getWorkspaceChatMaximumWidth, getWorkspaceChatWidth, workspaceResizeWidth } from '@/components/fileWorkspace/documentPresentation';

export const projectPanelGap = 10;
export const projectFileDefaultMaximumWidth = 760;

/** Keep the original cards visible while reserving a usable conversation/document. */
export function getProjectCatalogWidth(rowWidth: number, rightWidth: number) {
    const available = Math.max(0, rowWidth - rightWidth - 2 * projectPanelGap);
    return Math.min(620, Math.max(0, available - 360), Math.max(280, Math.floor(available * 0.46)));
}

export function getProjectTaskNavigationWidth(rowWidth: number) {
    return Math.min(264, Math.max(220, Math.floor(rowWidth * 0.18)));
}

export function canSplitProjectFile(rowWidth: number, rightWidth: number, taskNavigationWidth: number) {
    return rowWidth - rightWidth - taskNavigationWidth - (taskNavigationWidth ? projectPanelGap : 0) - projectPanelGap >= 640;
}

export function getProjectChatMaximumWidth(rowWidth: number, rightWidth: number) {
    return getWorkspaceChatMaximumWidth(rowWidth - projectPanelGap, rightWidth);
}

/** Share the working space evenly until the document reaches a useful reading width. */
export function getProjectChatWidth(preferred: number | undefined, rowWidth: number, rightWidth: number) {
    const available = Math.max(0, rowWidth - rightWidth - projectPanelGap - workspaceResizeWidth);
    const automatic = available - Math.min(projectFileDefaultMaximumWidth, available / 2);
    return getWorkspaceChatWidth(preferred ?? automatic, rowWidth - projectPanelGap, rightWidth);
}
