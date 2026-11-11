/** Only explicit Task ownership can route a conversation into a project workspace. */
export function projectSessionRoute(sessionId: string, metadata?: { machineId?: string; goalBoard?: { featurePath: string; taskId?: string } } | null) {
    if (!metadata?.machineId || !metadata.goalBoard?.taskId || !metadata.goalBoard.featurePath) return null;
    return { pathname: '/projects' as const, params: {
        machine: metadata.machineId, feature: metadata.goalBoard.featurePath,
        task: metadata.goalBoard.taskId, conversation: sessionId, view: 'chat',
    } };
}
