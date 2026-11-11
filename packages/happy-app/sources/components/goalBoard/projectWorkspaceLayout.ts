import { getWorkspaceChatMaximumWidth, getWorkspaceChatWidth, workspaceResizeWidth } from '@/components/fileWorkspace/documentPresentation';

export const projectPanelGap = 10;
export const projectFileDefaultMaximumWidth = 760;

export function getProjectChatMaximumWidth(rowWidth: number, rightWidth: number) {
    return getWorkspaceChatMaximumWidth(rowWidth - projectPanelGap, rightWidth);
}

/** Share the working space evenly until the document reaches a useful reading width. */
export function getProjectChatWidth(preferred: number | undefined, rowWidth: number, rightWidth: number) {
    const available = Math.max(0, rowWidth - rightWidth - projectPanelGap - workspaceResizeWidth);
    const automatic = available - Math.min(projectFileDefaultMaximumWidth, available / 2);
    return getWorkspaceChatWidth(preferred ?? automatic, rowWidth - projectPanelGap, rightWidth);
}
