import { accountIndex, adoptLegacySelection, canonicalAccountServer, commitAccountSelection, getActiveAccountKey, readAccountSelection } from './accountRuntime';
import { AccountVault, type AuthCredentials } from './tokenStorage';
import { getServerUrl } from '@/sync/serverConfig';
import { parseToken } from '@/utils/parseToken';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { normalizeSecretKey } from './secretKeyBackup';
import { authChallenge } from './authChallenge';
import { AsyncLock } from '@/utils/lock';

export type SavedAccount = { key: string; accountId: string; serverUrl: string; label: string; scope: string };
const lock = new AsyncLock();
const inRegistryLock = <T>(action: () => Promise<T>): Promise<T> => lock.inLock(async () => {
    if (typeof navigator !== 'undefined' && navigator.locks) return await navigator.locks.request('paws-account-registry', async () => await action());
    return await action();
});
export const withAccountRegistryLock = inRegistryLock;
export async function recoverAccountSelection(expectedGeneration: string | undefined): Promise<void> {
    await inRegistryLock(async () => {
        if (readAccountSelection()?.generation === expectedGeneration) commitAccountSelection(null);
    });
}
function rows(): SavedAccount[] { return JSON.parse(accountIndex.getString('accounts') || '[]'); }
const saveRows = (value: SavedAccount[]) => accountIndex.set('accounts', JSON.stringify(value));
export const listSavedAccounts = async (): Promise<SavedAccount[]> => rows();
export function accountKey(server: string, accountId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) throw new Error('Invalid account identity');
    return encodeBase64(new TextEncoder().encode(`${canonicalAccountServer(server)}\n${accountId}`), 'base64url');
}
const generation = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function credentialsMatch(credentials: AuthCredentials, account: SavedAccount): boolean {
    try { return parseToken(credentials.token) === account.accountId && decodeBase64(credentials.secret, 'base64url').length === 32; }
    catch { return false; }
}
export async function saveAccountCredentials(credentials: AuthCredentials, server: string, label?: string, legacy = false): Promise<SavedAccount> {
    return inRegistryLock(async () => {
        const serverUrl = canonicalAccountServer(server), accountId = parseToken(credentials.token);
        const key = accountKey(serverUrl, accountId), existing = rows().find(a => a.key === key);
        const account: SavedAccount = { key, accountId, serverUrl, label: label?.trim().slice(0, 80) || existing?.label || accountId, scope: existing?.scope || (legacy ? 'legacy' : key) };
        await AccountVault.write(key, credentials);
        saveRows([...rows().filter(a => a.key !== key), account]);
        return account;
    });
}
export async function migrateLegacyAccount(credentials: AuthCredentials): Promise<void> {
    if (readAccountSelection()) return;
    const account = await saveAccountCredentials(credentials, getServerUrl(), undefined, true);
    adoptLegacySelection({ ...account, generation: generation() });
    await AccountVault.removeLegacy();
}
export async function addSavedAccount(input: { secret: string; serverUrl: string; label?: string; expectedAccountId?: string }): Promise<SavedAccount> {
    const serverUrl = canonicalAccountServer(input.serverUrl);
    const secret = normalizeSecretKey(input.secret), bytes = decodeBase64(secret, 'base64url');
    if (bytes.length !== 32) throw new Error('Invalid secret');
    const challenge = authChallenge(bytes);
    const response = await fetch(`${serverUrl}/v1/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ challenge: encodeBase64(challenge.challenge), signature: encodeBase64(challenge.signature), publicKey: encodeBase64(challenge.publicKey) }),
    });
    if (!response.ok) throw new Error('Authentication failed');
    const { token } = await response.json();
    if (typeof token !== 'string') throw new Error('Authentication failed');
    const profileResponse = await fetch(`${serverUrl}/v1/account/profile`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!profileResponse.ok) throw new Error('Identity verification failed');
    const profile = await profileResponse.json();
    if (profile.id !== parseToken(token) || (input.expectedAccountId && profile.id !== input.expectedAccountId)) throw new Error('Account does not match');
    return saveAccountCredentials({ token, secret }, serverUrl, input.label || profile.github?.login || profile.firstName);
}
export async function selectSavedAccount(key: string): Promise<void> {
    return inRegistryLock(async () => {
        const account = rows().find(a => a.key === key);
        const credentials = account && await AccountVault.read(key);
        if (!account || !credentials || !credentialsMatch(credentials, account)) throw new Error('Account unavailable');
        commitAccountSelection({ ...account, generation: generation() });
    });
}
export async function validateSavedAccount(key: string): Promise<void> {
    const account = rows().find(a => a.key === key);
    const credentials = account && await AccountVault.read(key);
    if (!account || !credentials || !credentialsMatch(credentials, account)) throw new Error('Account unavailable');
}
export async function removeSavedAccount(key: string): Promise<void> {
    return inRegistryLock(async () => {
        if (getActiveAccountKey() === key) throw new Error('Cannot remove active account');
        await AccountVault.remove(key);
        saveRows(rows().filter(a => a.key !== key));
    });
}

// A stale tab must never sign out the account selected by a newer tab.
// Keep cleanup inside the same registry lock as the generation comparison.
export async function logoutSavedAccount(expectedGeneration: string | undefined, cleanup: () => Promise<void>): Promise<void> {
    return inRegistryLock(async () => {
        const selection = readAccountSelection();
        if (selection?.generation !== expectedGeneration) return;
        await cleanup();
        // Also guard platforms without Web Locks against a concurrent selection.
        if (readAccountSelection()?.generation !== expectedGeneration) return;
        commitAccountSelection(null);
        if (selection) {
            await AccountVault.remove(selection.key);
            saveRows(rows().filter(a => a.key !== selection.key));
        }
    });
}
