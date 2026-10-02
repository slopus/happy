import { getServerUrl } from '@/sync/serverConfig';

export interface AppAuthorizationRequest { id: string; publicKey: string; expiresAt: string; app: { id: string; name: string; origin: string; scope: string; protocol: number } }
export interface AppAuthorizationGrant { id: string; appId: string; machineId: string | null; state: string; expiresAt: string | null }
export async function appAuthorizationRequest<T>(token: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const server = getServerUrl();
    if (!server.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(server)) throw new Error('请使用 HTTPS 连接 Paws');
    const response = await fetch(`${server}/v1/app-authorizations${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(response.status === 409 ? '该设备暂不支持应用对话，请更新并启动 Paws 后重试' : '授权请求不可用、已过期或已处理，请重新连接');
    return response.json();
}
