import { z } from 'zod';
import { AppPolicySchema, CapabilityCatalogSchema, ExecutionBindingSchema, ServiceConfigSchema, ServiceGrantSchema, ServiceGrantScopeSchema, ServiceRefSchema, ServiceRevisionSchema, ServiceTargetSchema, TurnActualSchema, ServiceErrorSchema, TurnStatusSchema } from '@slopus/happy-wire';
import type { ServiceConfig, ServiceTarget } from '@slopus/happy-wire';
import { getServerUrl } from './serverConfig';

const snapshotSchema = z.object({ service: ServiceRefSchema, revision: ServiceRevisionSchema });
const workerSchema = z.object({ machineId: z.string(), serviceProtocol: z.literal('ai-services/1'), servicePublicKey: z.string().nullable(), serviceClaudeIdentity: z.string().nullable(), serviceClaudeObservedAt: z.string().nullable() });
const pairingSchema = z.object({ id: z.string(), protocol: z.literal('ai-services/1'), app: AppPolicySchema, publicKey: z.string(), expiresAt: z.number() });
const turnSchema = z.object({ id: z.string(), bindingId: z.string(), state: TurnStatusSchema, actual: TurnActualSchema.nullable(), createdAt: z.string(), startedAt: z.string().nullable(), completedAt: z.string().nullable(), serviceError: ServiceErrorSchema.nullable() });
export type ServiceSnapshot = z.infer<typeof snapshotSchema>;
export type AIServiceWorker = z.infer<typeof workerSchema>;
export type ServicePairing = z.infer<typeof pairingSchema>;
export type ServiceRecentTurn = z.infer<typeof turnSchema>;
const messages: Record<string, string> = {
    'revision-conflict': '配置已在别处更新。未保存输入已保留。请读取最新版本并核对后重试。',
    'consent-required': '此设备、账号或引擎尚未获授权。请让应用重新发起授权。',
    'machine-offline': '设备离线。请启动设备上的 Paws 后重试。',
    'account-login-required': '请在已有账号或设备入口完成登录。',
    'account-identity-changed': '设备的登录身份已改变。请重新选择账号并授权。',
    'resource-busy': '设备正在处理其他任务。请稍后重试。',
    'model-unavailable': '所选模型不可用。请刷新能力目录。',
    'parameter-unsupported': '当前模型不支持此设置。',
    'authorization-expired': '授权请求已过期。请从应用重新连接。',
    'protocol-incompatible': '请更新设备上的 Paws 后重试。',
    'invalid-response': '服务响应不兼容。请检查服务器版本。',
    'https-required': 'AI 服务需要 HTTPS 连接。',
};
export class AIServiceAPIError extends Error {
    constructor(public readonly code: string, public readonly status?: number) {
        super(messages[code] ?? 'AI 服务请求失败。请检查连接后重试。');
    }
}
/** No local configuration store: all reads and CAS writes use the owner service API. */
export function createAIServicesAPI(token: string) {
    async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
        const server = getServerUrl().replace(/\/$/, '');
        const url = new URL(server);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new AIServiceAPIError('https-required');
        const controller = new AbortController();
        // T4 native discovery takes up to 25s. Allow the server to finish and return its safe error.
        const timer = setTimeout(() => controller.abort(), 35_000);
        try {
            const response = await fetch(`${server}/v1/ai-services${path}`, { method, redirect: 'error', cache: 'no-store', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new AIServiceAPIError(ServiceErrorSchema.safeParse({ code: data?.error?.code, retryable: data?.error?.retryable }).data?.code ?? 'request-failed', response.status);
            const parsed = schema.safeParse(data);
            if (!parsed.success) throw new AIServiceAPIError('invalid-response');
            return parsed.data;
        } catch (error) {
            if (error instanceof AIServiceAPIError) throw error;
            throw new AIServiceAPIError('network-error');
        } finally { clearTimeout(timer); }
    }
    const id = encodeURIComponent;
    return {
        grants: () => request('/authorizations', z.object({ grants: z.array(ServiceGrantSchema) })),
        list: () => request('', z.object({ services: z.array(ServiceRefSchema) })),
        read: (serviceId: string) => request(`/${id(serviceId)}`, snapshotSchema),
        create: (name: string, config: ServiceConfig) => request('', z.object({ service: ServiceRefSchema }), 'POST', { name, config: ServiceConfigSchema.parse(config) }),
        update: (serviceId: string, expectedRevision: number, config: ServiceConfig) => request(`/${id(serviceId)}`, z.object({ revision: ServiceRevisionSchema }), 'PUT', { expectedRevision, config: ServiceConfigSchema.parse(config) }),
        metadata: (serviceId: string, expectedRevision: number, metadata: { name?: string; enabled?: boolean }) => request(`/${id(serviceId)}`, z.object({ service: ServiceRefSchema }), 'PATCH', { expectedRevision, metadata }),
        remove: (serviceId: string, expectedRevision: number) => request(`/${id(serviceId)}`, z.object({ deleted: z.literal(true) }), 'DELETE', { expectedRevision }),
        workers: () => request('/workers', z.object({ workers: z.array(workerSchema) })),
        capabilities: (target: ServiceTarget) => request('/capabilities', z.object({ catalog: CapabilityCatalogSchema }), 'POST', ServiceTargetSchema.parse(target)),
        authorizations: (serviceId: string) => request(`/${id(serviceId)}/authorizations`, z.object({ grants: z.array(ServiceGrantSchema) })),
        revoke: (grantId: string) => request(`/authorizations/${id(grantId)}`, z.object({ revoked: z.literal(true) }), 'DELETE'),
        turns: (serviceId: string) => request(`/${id(serviceId)}/turns`, z.object({ turns: z.array(turnSchema) })),
        binding: (bindingId: string) => request(`/bindings/${id(bindingId)}`, z.object({ binding: ExecutionBindingSchema })),
        application: (appId: string) => request(`/applications/${id(appId)}`, z.object({ app: AppPolicySchema })),
        pairing: (pairingId: string) => request(`/pairings/${id(pairingId)}`, pairingSchema),
        approve: (pairingId: string, body: { scope: z.infer<typeof ServiceGrantScopeSchema>; appEnvelope: string; machineEnvelopes: Record<string, string> }) => request(`/pairings/${id(pairingId)}/approve`, ServiceGrantSchema, 'POST', body),
    };
}
export type AIServicesAPI = ReturnType<typeof createAIServicesAPI>;
