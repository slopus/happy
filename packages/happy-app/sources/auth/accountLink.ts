import { canonicalAccountServer } from './accountRuntime';

export type AccountSessionTarget = { accountId: string; serverUrl: string; sessionId: string };
export function parseAccountSessionTarget(params: Record<string, unknown>): AccountSessionTarget | null {
    try {
        const { accountId, serverUrl, sessionId } = params;
        if (typeof accountId !== 'string' || typeof serverUrl !== 'string' || typeof sessionId !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return null;
        return { accountId, serverUrl: canonicalAccountServer(serverUrl), sessionId };
    } catch { return null; }
}
// Public identifiers only. Never put tokens or recovery keys in a link.
export function createAccountSessionLink(pawsOrigin: string, target: AccountSessionTarget): string {
    const parsed = parseAccountSessionTarget(target);
    if (!parsed) throw new Error('Invalid account session target');
    return `${canonicalAccountServer(pawsOrigin)}/accounts?${new URLSearchParams(parsed).toString()}`;
}
