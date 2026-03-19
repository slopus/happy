export type SessionPreviewToggleAction = 'expand' | 'collapse';

export function getSessionPreviewToggleAction({
    isLong,
    isExpanded,
}: {
    isLong: boolean;
    isExpanded: boolean;
}): SessionPreviewToggleAction | null {
    if (!isLong) {
        return null;
    }

    return isExpanded ? 'collapse' : 'expand';
}

export function isSessionPreviewMessageTruncated({
    lineCount,
    collapsedLineCount,
}: {
    lineCount: number;
    collapsedLineCount: number;
}): boolean {
    return lineCount > collapsedLineCount;
}
