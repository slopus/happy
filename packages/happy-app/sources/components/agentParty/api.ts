import type { AuthCredentials } from '@/auth/tokenStorage';
import { accountRuntimeCurrent, canonicalAccountServer } from '@/auth/accountRuntime';
import { getServerUrl } from '@/sync/serverConfig';

export const PARTY_ORIGIN = 'https://47.115.228.20:8443';
export const PARTY_URL = `${PARTY_ORIGIN}/agent-party/`;
export class CatalogError extends Error { constructor(message: string, public readonly status: number) { super(message); } }
export type AgentProfile = { id: string; name: string; instructions: string; engine: 'codex'; model: string; effort: string; avatarId: number; machineId?: string; directory?: string; createdAt: number; updatedAt: number };
export type AgentInput = Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>;
export type Machine = { id: string; active: boolean; metadata: { displayName?: string; host?: string } | null };
export type Directory = { path: string; parent?: string | null; directories: { name: string; path: string }[] };

async function request<T>(path: string, token: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
    if (!accountRuntimeCurrent()) throw Error('账号已切换，请重新打开。');
    const response = await fetch(`${PARTY_URL}api/${path}`, { ...init, signal, headers: { Origin: PARTY_ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${token}` } });
    const value = await response.json();
    if (!accountRuntimeCurrent() || signal.aborted) throw Error('账号连接已取消。');
    if (!response.ok) throw new CatalogError(value.error || '连接失败，请重试。', response.status);
    return value;
}
export async function issuePartyTicket(credentials: AuthCredentials, signal: AbortSignal): Promise<string> {
    if (canonicalAccountServer(getServerUrl()) !== PARTY_ORIGIN) throw Error('请切换到 Paws 正式服务器的账号。');
    const result = await request<{ ticket: string }>('access/ticket', credentials.token, signal, { method: 'POST', body: JSON.stringify({ secret: credentials.secret }) });
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.ticket)) throw Error('登录信息无效。');
    return result.ticket;
}
export async function connectAgentCatalog(credentials: AuthCredentials, signal: AbortSignal) {
    const authorize = async () => {
        const ticket = await issuePartyTicket(credentials, signal);
        return (await request<{ token: string }>('access/exchange', '', signal, { method: 'POST', body: JSON.stringify({ ticket }) })).token;
    };
    let token = await authorize();
    let renewal: Promise<void> | null = null;
    return {
        request: async <T,>(path: string, init?: RequestInit): Promise<T> => {
            const attemptedToken = token;
            try { return await request<T>(path, attemptedToken, signal, init); }
            catch (error) {
                if (!(error instanceof CatalogError) || error.status !== 401) throw error;
                // A 401 is returned before any mutation. Renew once, preserving the editor draft.
                if (token === attemptedToken) {
                    renewal ??= authorize().then(value => { token = value; }).finally(() => { renewal = null; });
                    await renewal;
                }
                return request<T>(path, token, signal, init);
            }
        },
        close: () => { void fetch(`${PARTY_URL}api/access/logout`, { method: 'POST', headers: { Origin: PARTY_ORIGIN, authorization: `Bearer ${token}` }, keepalive: true }).catch(() => undefined); },
    };
}
