import { ServiceTargetSchema } from '@slopus/happy-wire/ai-services';
import type { AIServiceClient } from './client';
import { safeServiceError } from './client';
import { AIServiceClientError, type ExecutionBinding } from './types';
import { validateIdentifier, validateMessages, validateOverrides } from './scopedTransport';
export interface PlatformOperation {
    operation: 'connection' | 'services' | 'configuration' | 'capabilities' | 'create' | 'find' | 'start' | 'read' | 'cancel' | 'revoke';
    bindingId?: string;
    turnId?: string;
    requestId?: string;
    appConversationId?: string;
}
export interface PlatformHostAuthorization<Context> {
    /** Context MUST come from the host's verified session. Return true only after login/CSRF and ownership checks. */
    authorize(operation: PlatformOperation, context: Context): Promise<boolean>;
    /** Persist the binding association before returning it. Retries for appConversationId must retain the same owner. */
    registerConversation(binding: ExecutionBinding, appConversationId: string | undefined, context: Context): Promise<void>;
    /** Return an authoritative saved binding for an already authorized host user's conversation. */
    resolveBinding(bindingId: string, context: Context): Promise<ExecutionBinding>;
}
export interface PlatformBridgeRequest {
    method: string;
    path: string;
    body?: unknown;
    signal?: AbortSignal;
}
/** Route below one host-controlled prefix. No default-allow authorization and no body-supplied subject. */
export function createPlatformServiceHandler<Context>(client: AIServiceClient, host: PlatformHostAuthorization<Context>) {
    if (client.source !== 'platform' || !host?.authorize || !host.registerConversation || !host.resolveBinding)
        throw new AIServiceClientError('permission-denied');
    return async (request: PlatformBridgeRequest, context: Context): Promise<{
        status: number;
        headers: Record<string, string>;
        body: unknown;
    }> => {
        const headers = { 'Cache-Control': 'no-store' };
        try {
            const parts = request.path.split('/').filter(Boolean).map(p => decodeURIComponent(p));
            if (parts.some(p => p.includes('/') || !p.trim() || p.length > 256) || request.path.includes('?'))
                throw new AIServiceClientError('invalid-request');
            const body = request.body ?? {}, signal = { signal: request.signal };
            const strict = (keys: string[]) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k)))
                throw new AIServiceClientError('invalid-request'); return body as Record<string, any>; };
            let operation: PlatformOperation;
            if (request.method === 'GET' && parts.length === 1 && ['connection', 'services', 'configuration'].includes(parts[0]))
                operation = { operation: parts[0] as 'connection' | 'services' | 'configuration' };
            else if (request.method === 'POST' && parts.length === 1 && parts[0] === 'capabilities') {
                const b = strict(['target']);
                if (b.target !== undefined && !ServiceTargetSchema.safeParse(b.target).success) throw new AIServiceClientError('invalid-request');
                operation = { operation: 'capabilities' };
            }
            else if (request.method === 'POST' && parts.length === 1 && parts[0] === 'conversations') {
                const b = strict(['overrides', 'appConversationId']);
                if (b.appConversationId !== undefined)
                    validateIdentifier(b.appConversationId);
                operation = { operation: 'create', appConversationId: b.appConversationId };
            }
            else if (request.method === 'GET' && parts.length === 3 && parts[0] === 'conversations' && parts[2] === 'binding')
                operation = { operation: 'find', appConversationId: parts[1] };
            else if (parts[0] === 'bindings' && parts[2] === 'turns' && parts.length === 3 && request.method === 'POST') {
                const b = strict(['messages', 'requestId']);
                validateIdentifier(b.requestId);
                operation = { operation: 'start', bindingId: parts[1], requestId: b.requestId };
            }
            else if (parts[0] === 'bindings' && ['turns', 'requests'].includes(parts[2]) && parts.length === 4 && request.method === 'GET')
                operation = { operation: 'read', bindingId: parts[1], ...(parts[2] === 'turns' ? { turnId: parts[3] } : { requestId: parts[3] }) };
            else if (parts[0] === 'bindings' && parts[2] === 'turns' && parts[4] === 'cancel' && parts.length === 5 && request.method === 'POST') {
                strict([]);
                operation = { operation: 'cancel', bindingId: parts[1], turnId: parts[3] };
            }
            else if (request.method === 'POST' && parts.length === 1 && parts[0] === 'revoke') {
                strict([]);
                operation = { operation: 'revoke' };
            }
            else
                throw new AIServiceClientError('invalid-request');
            if (await host.authorize(Object.freeze(operation), context) !== true)
                throw new AIServiceClientError('permission-denied');
            let result: unknown;
            switch (operation.operation) {
                case 'connection':
                    result = await client.connections.authorize(signal);
                    break;
                case 'services':
                    result = await client.services.list(signal);
                    break;
                case 'configuration':
                    result = await client.services.configuration(signal);
                    break;
                case 'capabilities':
                    result = { catalog: await client.capabilities.read({...signal, ...((body as any).target ? {target: (body as any).target} : {})}) };
                    break;
                case 'create': {
                    const b = body as Record<string, any>;
                    const binding = await client.conversations.create({ appConversationId: b.appConversationId, overrides: validateOverrides(b.overrides) }, signal);
                    await host.registerConversation(binding, b.appConversationId, context);
                    result = { binding };
                    break;
                }
                case 'find': {
                    const binding = await client.conversations.find(operation.appConversationId!, signal);
                    if (binding)
                        await host.registerConversation(binding, operation.appConversationId, context);
                    result = { binding };
                    break;
                }
                case 'start': {
                    const b = body as Record<string, any>;
                    const binding = await host.resolveBinding(operation.bindingId!, context);
                    if (binding.id !== operation.bindingId || binding.appId !== client.appId)
                        throw new AIServiceClientError('permission-denied');
                    result = await client.turns.start({ binding, requestId: b.requestId, messages: validateMessages(b.messages) }, signal);
                    break;
                }
                case 'read':
                    result = await client.turns.read({ bindingId: operation.bindingId!, turnId: operation.turnId, requestId: operation.requestId }, signal);
                    break;
                case 'cancel':
                    result = await client.turns.cancel({ bindingId: operation.bindingId!, turnId: operation.turnId! }, signal);
                    break;
                case 'revoke':
                    await client.connections.revoke(signal);
                    result = { revoked: true };
                    break;
            }
            return { status: 200, headers, body: result };
        }
        catch (error) {
            const safe = safeServiceError(error);
            return { status: safe.code === 'permission-denied' ? 403 : safe.code === 'transport-error' ? 503 : 409, headers, body: { error: { code: safe.code, retryable: safe.retryable, ...(safe.submission === 'not-submitted' && safe.requestId ? { submission: safe.submission, requestId: safe.requestId } : {}) } } };
        }
    };
}
