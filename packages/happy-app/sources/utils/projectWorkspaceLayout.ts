/**
 * A primary workspace is implicit in a project card. Every named workspace
 * needs a branch label, including the first visible one after filtering.
 */
export function shouldShowWorktreeDivider(workspaceName: string | null): boolean {
    return workspaceName !== null;
}
