import type { GoalProject, GoalBoardSnapshot } from '@slopus/happy-wire';

export type WorkspaceSessionMetadata = {
    machineId?: string; path: string;
    goalBoard?: { featurePath: string; taskId?: string };
};
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
type Scope = { project: string; feature?: string; path: string; taskId?: string; directoryTask: boolean };

/** Explicit ownership wins. Legacy conversations use exact, catalogued directories. */
export function findSessionWorkspace(metadata: WorkspaceSessionMetadata, projects: GoalProject[]): Scope | null {
    if (!metadata.machineId) return null;
    const scopes: Scope[] = projects.flatMap(project => [
        ...[...(project.direct ? [project.direct] : []), ...project.features].map(feature => ({
            project: project.projectPath, feature: feature.featurePath, path: feature.featurePath, directoryTask: false,
        })),
        { project: project.projectPath, path: project.projectPath, directoryTask: false },
    ]);
    const ownership = metadata.goalBoard;
    if (ownership) {
        const scope = scopes.find(scope => normalize(scope.path) === normalize(ownership.featurePath));
        return scope ? { ...scope, taskId: ownership.taskId, directoryTask: false } : null;
    }
    const directory = normalize(metadata.path);
    const exact = scopes.find(scope => normalize(scope.path) === directory);
    if (exact) return exact;
    const taskScopes = scopes.filter(scope => scope.feature && directory.startsWith(`${normalize(scope.path)}/tasks/`));
    // Ambiguous catalog ownership must never silently choose a different project.
    return taskScopes.length === 1 ? { ...taskScopes[0], directoryTask: true } : null;
}

export async function sessionWorkspaceRoute(sessionId: string, metadata: WorkspaceSessionMetadata, projects: GoalProject[],
    readBoard: (machineId: string, featurePath: string) => Promise<{ snapshot: GoalBoardSnapshot }>) {
    const scope = findSessionWorkspace(metadata, projects);
    if (!scope || !metadata.machineId) return null;
    let taskId = scope.taskId;
    if (taskId || scope.directoryTask) {
        if (!scope.feature) return null;
        const { snapshot } = await readBoard(metadata.machineId, scope.feature);
        if (normalize(snapshot.featurePath) !== normalize(scope.feature)) return null;
        const task = snapshot.tasks.find(task => taskId ? task.id === taskId
            : normalize(task.indexPath.replace(/[\\/][^\\/]+$/, '')) === normalize(metadata.path));
        if (!task) return null;
        taskId = task.id;
    }
    return { pathname: '/projects' as const, params: {
        machine: metadata.machineId, project: scope.project, feature: scope.feature,
        task: taskId, conversation: taskId ? sessionId : undefined, author: taskId ? undefined : sessionId, view: 'chat', file: undefined,
    } };
}
