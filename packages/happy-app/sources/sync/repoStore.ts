import { AuthCredentials } from '@/auth/tokenStorage';
import { RegisteredRepo, REPOS_KV_KEY } from '@/utils/workspaceRepos';
import { kvGet, kvSet } from './apiKv';

/**
 * Load registered repos for a machine from UserKVStore.
 * Returns { repos, version } where version is -1 if no entry exists yet.
 */
export async function loadRegisteredRepos(
    credentials: AuthCredentials,
    machineId: string
): Promise<{ repos: RegisteredRepo[]; version: number }> {
    const key = REPOS_KV_KEY(machineId);
    const item = await kvGet(credentials, key);

    if (!item) {
        return { repos: [], version: -1 };
    }

    try {
        const json = new TextDecoder().decode(
            Uint8Array.from(atob(item.value), c => c.charCodeAt(0))
        );
        const repos = JSON.parse(json) as RegisteredRepo[];
        return { repos, version: item.version };
    } catch {
        // Corrupted data — treat as empty
        console.warn(`[repoStore] Failed to parse repos for machine ${machineId}, returning empty`);
        return { repos: [], version: item.version };
    }
}

/**
 * Save registered repos for a machine to UserKVStore.
 * Returns the new version number from the server.
 *
 * @param version - Current version for optimistic concurrency (-1 for first write)
 */
export async function saveRegisteredRepos(
    credentials: AuthCredentials,
    machineId: string,
    repos: RegisteredRepo[],
    version: number
): Promise<number> {
    const key = REPOS_KV_KEY(machineId);
    const json = JSON.stringify(repos);
    const value = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    return await kvSet(credentials, key, value, version);
}
