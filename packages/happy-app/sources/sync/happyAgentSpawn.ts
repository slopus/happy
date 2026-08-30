/** A catalog-owned destination understood by Happy Agent's native spawn RPC. */
export type HappyAgentSpawnTarget =
    | { kind: 'project'; id: string }
    | { kind: 'workspace'; id: string }
    | { kind: 'newWorkspace'; projectId: string };

/**
 * Resolves the workspace picker state to a durable Happy Agent catalog target.
 * A null project means this is an ordinary directory spawn. Once a project is
 * known, an unknown workspace must never fall back to importing its path as a
 * second project.
 */
export function resolveHappyAgentSpawnTarget(options: {
    projectId: string | null | undefined;
    workspaceSelection: string;
    workspaces: readonly { id: string; path: string }[];
}): HappyAgentSpawnTarget | null {
    const projectId = options.projectId?.trim();
    if (!projectId) return null;

    if (options.workspaceSelection === '__new__') {
        return { kind: 'newWorkspace', projectId };
    }
    if (options.workspaceSelection === '__none__') {
        return { kind: 'project', id: projectId };
    }

    const workspace = options.workspaces.find((candidate) => (
        candidate.path === options.workspaceSelection
    ));
    if (!workspace) {
        throw new Error('The selected Happy Agent workspace is no longer available.');
    }
    return { kind: 'workspace', id: workspace.id };
}