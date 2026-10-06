/** Explicit login context only. Ordinary login and account switching do not read it. */
export type ServiceAuthorizationLogin = { id: string; protocol: 'ai-services/1'; startedAt: number };
const fields = ['serviceAuthorizationId', 'serviceAuthorizationProtocol', 'serviceAuthorizationStartedAt'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxAge = 10 * 60_000;

export function serviceAuthorizationReturnPath(value: unknown, now = Date.now()): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const intent = value as Record<string, unknown>;
    if (Object.keys(intent).length !== 3 || !Object.keys(intent).every(key => ['id', 'protocol', 'startedAt'].includes(key))
        || typeof intent.id !== 'string' || !uuid.test(intent.id) || intent.protocol !== 'ai-services/1'
        || typeof intent.startedAt !== 'number' || !Number.isSafeInteger(intent.startedAt) || intent.startedAt < 0
        || intent.startedAt > now || now - intent.startedAt >= maxAge) return null;
    return `/apps/authorize?id=${intent.id}&protocol=ai-services%2F1`;
}

export function createServiceAuthorizationLogin(id: string, now = Date.now()): ServiceAuthorizationLogin | null {
    const intent: ServiceAuthorizationLogin = { id, protocol: 'ai-services/1', startedAt: now };
    return serviceAuthorizationReturnPath(intent, now) ? intent : null;
}

export function hasServiceAuthorizationLogin(params: Record<string, unknown>): boolean {
    return fields.some(field => params[field] !== undefined);
}

export function parseServiceAuthorizationLogin(params: Record<string, unknown>, now = Date.now()): ServiceAuthorizationLogin | null {
    const startedAt = params.serviceAuthorizationStartedAt;
    if (typeof startedAt !== 'string' || !/^\d{1,16}$/.test(startedAt)) return null;
    const intent = { id: params.serviceAuthorizationId, protocol: params.serviceAuthorizationProtocol, startedAt: Number(startedAt) };
    return serviceAuthorizationReturnPath(intent, now) ? intent as ServiceAuthorizationLogin : null;
}

export function serviceAuthorizationLoginParams(intent: ServiceAuthorizationLogin): Record<string, string> {
    return { serviceAuthorizationId: intent.id, serviceAuthorizationProtocol: intent.protocol, serviceAuthorizationStartedAt: String(intent.startedAt) };
}
