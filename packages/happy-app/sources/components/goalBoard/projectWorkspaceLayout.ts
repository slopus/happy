import { getWorkspaceChatMaximumWidth, getWorkspaceChatWidth, workspaceResizeWidth } from '@/components/fileWorkspace/documentPresentation';

export const projectPanelGap = 10;
export const projectFileDefaultMaximumWidth = 760;

/** Keep the original cards visible while reserving a usable conversation/document. */
export function getProjectCatalogWidth(rowWidth: number, rightWidth: number, preferred?: number) {
    const available = Math.max(0, rowWidth - rightWidth - 2 * projectPanelGap);
    const maximum = getProjectCatalogMaximumWidth(rowWidth, rightWidth);
    return Math.min(maximum, Math.max(280, preferred !== undefined && Number.isFinite(preferred) ? preferred : Math.min(620, Math.floor(available * 0.46))));
}

/** Leave the center readable even when the window shrinks after a manual resize. */
export function getProjectCatalogMaximumWidth(rowWidth: number, rightWidth: number) {
    return Math.max(0, rowWidth - rightWidth - 2 * projectPanelGap - 360);
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
