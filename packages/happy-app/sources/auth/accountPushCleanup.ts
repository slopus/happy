import { accountIndex, getActiveAccountKey } from './accountRuntime';
import { AccountVault } from './tokenStorage';
import { accountCleanupFetch } from './accountNetwork';
import { withAccountRegistryLock } from './accounts';

type Cleanup = { id: string; accountKey: string; serverUrl: string; pushToken: string; attempts: number; nextAttempt: number };
const read = (): Cleanup[] => JSON.parse(accountIndex.getString('push-cleanup') || '[]');
const save = (jobs: Cleanup[]) => accountIndex.set('push-cleanup', JSON.stringify(jobs));
const locked = withAccountRegistryLock;
async function discard(job: Cleanup): Promise<void> {
    save(read().filter(value => value.id !== job.id));
    await AccountVault.remove(job.id);
}
async function attempt(job: Cleanup): Promise<void> {
    const credentials = await AccountVault.read(job.id);
    if (!credentials) return;
    try {
        const response = await accountCleanupFetch(`${job.serverUrl}/v1/push-tokens/${encodeURIComponent(job.pushToken)}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(3000),
        });
        if (!response.ok && response.status !== 404) throw new Error('Push cleanup failed');
        await discard(job);
    } catch {
        const updated = { ...job, attempts: job.attempts + 1, nextAttempt: Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 6)) };
        save(read().map(value => value.id === job.id ? updated : value));
    }
}
export async function retireAccountPush(input: { accountKey: string; serverUrl: string; pushToken: string; token: string }): Promise<void> {
    await locked(async () => {
        const id = `push_cleanup_${input.accountKey}`;
        const job: Cleanup = { id, accountKey: input.accountKey, serverUrl: input.serverUrl, pushToken: input.pushToken, attempts: 0, nextAttempt: 0 };
        // A scoped vault entry retains only the auth token, never the recovery key.
        await AccountVault.write(id, { token: input.token, secret: '' });
        save([...read().filter(value => value.id !== id), job]);
        await attempt(job);
    });
}
export async function retryAccountPushCleanup(): Promise<void> {
    await locked(async () => {
        // Returning to this account registers its token again: do not delete it.
        for (const job of read().filter(value => value.accountKey === getActiveAccountKey())) await discard(job);
        // Filter before limiting so delayed failures cannot starve later tasks.
        for (const job of read().filter(value => value.nextAttempt <= Date.now()).sort((a, b) => a.nextAttempt - b.nextAttempt).slice(0, 3)) await attempt(job);
    });
}
