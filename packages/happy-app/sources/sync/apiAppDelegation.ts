import { getServerUrl } from '@/sync/serverConfig';

export interface AppAuthorizationRequest { id: string; supportsPermanent?: boolean; publicKey: string; expiresAt: string; app: { id: string; name: string; origin: string; scope: string; protocol: number } }
export interface AppAuthorizationGrant { id: string; appId: string; machineId: string | null; state: string; expiresAt: string | null; createdAt: string }
export async function appAuthorizationRequest<T>(token: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
    const server = getServerUrl();
    if (!server.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(server)) throw new Error('请使用 HTTPS 连接 Paws');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15_000);
    try {
        const response = await fetch(`${server}/v1/app-authorizations${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
        if (!response.ok) throw Object.assign(new Error(response.status === 409 ? '该设备暂不支持应用对话，请更新并启动 Paws 后重试' : '授权请求不可用、已过期或已处理，请重新连接'), { status: response.status });
        return await response.json();
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
}

export interface AppConversationEntry {
    id: string;
    grantId: string;
    createdAt: string;
    lastActivityAt: string;
    turns: { state: string; createdAt: string }[];
}
export interface AppConversationDirectory { conversations: AppConversationEntry[]; nextCursor: string | null }
export function isAppGrantActive(grant: AppAuthorizationGrant, now = Date.now()) {
    return ['approved', 'redeemed'].includes(grant.state) && (grant.expiresAt === null || Date.parse(grant.expiresAt) > now);
}

/** New SDK links explicitly name the service protocol. Never fall back from an unknown protocol. */
export function appAuthorizationProtocol(protocol: unknown): 'legacy' | 'ai-services/1' | 'unsupported' {
    if (protocol === undefined || protocol === '1' || protocol === '2' || protocol === '3') return 'legacy';
    return protocol === 'ai-services/1' ? protocol : 'unsupported';
}

/** Seals personal keys on the owner client. Only recipient ciphertext goes to the Paws backend. */
export async function sealServiceConsent(input: {
    pairing: import('./apiAIServices').ServicePairing;
    service: import('@slopus/happy-wire').ServiceRef;
    scope: import('@slopus/happy-wire').ServiceGrantScope;
    workers: import('./apiAIServices').AIServiceWorker[];
}) {
    const { pairing, service, scope, workers } = input;
    if (pairing.protocol !== 'ai-services/1' || pairing.expiresAt <= Date.now() || scope.appId !== pairing.app.appId || scope.serviceId !== service.id || !service.enabled || scope.permissions.some(p => !pairing.app.capabilities.includes(p))) throw new Error('授权范围无效或请求已过期。');
    const [{ getRandomBytes }, { encodeBase64, decodeBase64 }, { encryptBox }, { ServiceGrantScopeSchema }] = await Promise.all([
        import('expo-crypto'), import('@/encryption/base64'), import('@/encryption/libsodium'), import('@slopus/happy-wire'),
    ]);
    ServiceGrantScopeSchema.parse(scope);
    const recipients = [...new Set(scope.targets.map(t => t.machineId))].map(machineId => {
        const worker = workers.find(w => w.machineId === machineId && w.serviceProtocol === 'ai-services/1');
        if (!worker?.servicePublicKey || decodeBase64(worker.servicePublicKey).length !== 32) throw new Error('设备的加密密钥不可用。请刷新设备状态。');
        return { machineId, publicKey: worker.servicePublicKey };
    });
    if (decodeBase64(pairing.publicKey).length !== 32) throw new Error('应用加密密钥无效。');
    const messageKey = getRandomBytes(32);
    try {
        const plaintext = { protocol: 'ai-services/1', grantId: pairing.id, ownerId: service.ownerId, appId: scope.appId, serviceId: service.id, scope, messageKey: encodeBase64(messageKey) };
        const seal = (value: unknown, key: string) => encodeBase64(encryptBox(new TextEncoder().encode(JSON.stringify(value)), decodeBase64(key)));
        return { scope, appEnvelope: seal(plaintext, pairing.publicKey), machineEnvelopes: Object.fromEntries(recipients.map(r => [r.machineId, seal({ ...plaintext, machineId: r.machineId }, r.publicKey)])) };
    } finally { messageKey.fill(0); }
}
