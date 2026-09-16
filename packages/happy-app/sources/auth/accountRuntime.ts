import { accountIndex } from './accountIndex';
export { accountIndex };
export type AccountSelection = { key: string; serverUrl: string; scope: string; generation: string };
export function readAccountSelection(): AccountSelection | null {
    const raw = accountIndex.getString('active');
    if (!raw) return null;
    try {
        const value = JSON.parse(raw);
        if (!value || typeof value.key !== 'string' || typeof value.scope !== 'string' ||
            typeof value.generation !== 'string' || !value.generation ||
            !/^[a-zA-Z0-9_-]+$/.test(value.key) || !/^[a-zA-Z0-9_-]+$/.test(value.scope) ||
            canonicalAccountServer(value.serverUrl) !== value.serverUrl) return null;
        return value;
    } catch { return null; }
}
let runtimeSelection = readAccountSelection();
const legacyBoot = !accountIndex.getString('initialized');
let frozen = false;
export function canonicalAccountServer(value: string): string {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid account server');
    return url.origin;
}
export const getActiveAccountKey = () => readAccountSelection()?.key ?? null;
export const getRuntimeAccountServer = () => runtimeSelection?.serverUrl;
export const getRuntimeAccountSelection = () => runtimeSelection;
export function accountStorageId(base: string): string;
export function accountStorageId(): string | undefined;
export function accountStorageId(base?: string): string | undefined {
    if (!runtimeSelection) return legacyBoot ? base : `${base || 'default'}-signed-out`;
    if (runtimeSelection.scope === 'legacy') return base;
    return `${base || 'default'}-account-${runtimeSelection.scope}`;
}
export function assertAccountRuntime(): void {
    if (frozen || readAccountSelection()?.generation !== runtimeSelection?.generation) throw new Error('Account changed; reload required');
}
export function accountRuntimeCurrent(): boolean {
    try { assertAccountRuntime(); return true; } catch { return false; }
}
export function freezeAccountRuntime(): void { frozen = true; }
export function commitAccountSelection(selection: AccountSelection | null): void {
    if (selection) {
        accountIndex.set('active', JSON.stringify(selection));
        accountIndex.set('initialized', '1');
    }
    else {
        accountIndex.set('initialized', '1');
        accountIndex.delete('active');
    }
}
export function adoptLegacySelection(selection: AccountSelection): void {
    if (runtimeSelection || frozen || selection.scope !== 'legacy') throw new Error('Cannot adopt account in an initialized runtime');
    commitAccountSelection(selection);
    runtimeSelection = selection;
}
