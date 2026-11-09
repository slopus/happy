import type { ViewStyle } from 'react-native';

/** The same reading geometry for working Markdown and immutable history. */
export const documentScrollStyle: ViewStyle = { paddingHorizontal: 28, paddingTop: 32, paddingBottom: 64 };
export const documentBodyStyle: ViewStyle = { width: '100%', maxWidth: 840, alignSelf: 'center' };

export const workspaceChatMinWidth = 310;
export const workspaceResizeWidth = 6;

/** Only reserve the document's usable minimum; the user owns the split ratio. */
export function getWorkspaceChatMaximumWidth(rowWidth: number, rightPanelWidth: number): number {
    return Math.max(workspaceChatMinWidth, rowWidth - rightPanelWidth - workspaceResizeWidth - 240);
}

export function getWorkspaceChatWidth(preferred: number, rowWidth: number, rightPanelWidth: number): number {
    return Math.max(workspaceChatMinWidth, rowWidth > 0 ? Math.min(preferred, getWorkspaceChatMaximumWidth(rowWidth, rightPanelWidth)) : preferred);
}
