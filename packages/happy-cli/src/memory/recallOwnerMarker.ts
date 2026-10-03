export const RECALL_OWNER_ENV = 'CLAUDE_MEMORY_RECALL_OWNER';

/** Recomputed for every spawn/reconnect; never mutate the launcher's environment. */
export function withCodexRecallOwnership<T extends NodeJS.ProcessEnv>(env: T, hostPrepared: boolean): T {
    const child: NodeJS.ProcessEnv = { ...env };
    delete child[RECALL_OWNER_ENV];
    if (hostPrepared) child[RECALL_OWNER_ENV] = 'host';
    return child as T;
}
