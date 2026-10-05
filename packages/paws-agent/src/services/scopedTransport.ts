import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { AppPolicySchema, CapabilityCatalogSchema, ExecutionBindingSchema, GrantReceiptSchema, ServiceErrorSchema, ServiceRefSchema, TurnRecordSchema } from '@slopus/happy-wire/ai-services';
import { decodeBase64, encodeBase64, getRandomBytes } from '../crypto/encryption';
import { AIServiceClientError, type AIServiceTransport, type CallOptions, type GrantReceipt, type ExecutionBinding, type ServiceMessage, type StartTurnInput, type TurnLocator, type TurnSnapshot, type BindingOverrides } from './types';
import type { ServiceStorage } from './storage';
export interface ScopedTransportOptions {
    appId: string;
    serverUrl: string;
    storage: ServiceStorage;
    fetch?: typeof fetch;
    origin?: string;
    revoke?: (id: string, options?: CallOptions) => Promise<void>;
}
export function canonical(value: unknown): string { if (Array.isArray(value))
    return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object')
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'; return JSON.stringify(value); }
export function validateIdentifier(id: string) { if (typeof id !== 'string' || !id.trim() || id.length > 256)
    throw new AIServiceClientError('invalid-request'); return encodeURIComponent(id); }
export function validateMessages(input: unknown): ServiceMessage[] {
    if (!Array.isArray(input) || !input.length || input.length > 100)
        throw new AIServiceClientError('invalid-request');
    const messages = input.map(value => {
        if (!value || !['user', 'assistant'].includes(value.role) || typeof value.text !== 'string' || (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 4 || !value.images.every((url: unknown) => typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(url)))))
            throw new AIServiceClientError('invalid-request');
        return { role: value.role, text: value.text, ...(value.images === undefined ? {} : { images: [...value.images] }) };
    });
    if (messages.at(-1)?.role !== 'user' || new TextEncoder().encode(JSON.stringify(messages)).length > 5 * 1024 * 1024)
        throw new AIServiceClientError('invalid-request');
    return messages;
}
export function validateOverrides(value: BindingOverrides = {}): BindingOverrides {
    if (!value || Object.keys(value).some(k => !['modelId', 'reasoning', 'permissions'].includes(k)))
        throw new AIServiceClientError('invalid-request');
    if (value.modelId !== undefined && value.modelId !== null)
        validateIdentifier(value.modelId);
    if (value.reasoning !== undefined && (value.reasoning.mode === 'default' ? Object.keys(value.reasoning).length !== 1 : value.reasoning.mode !== 'explicit' || typeof value.reasoning.value !== 'string' || !value.reasoning.value.trim() || value.reasoning.value.length > 256 || Object.keys(value.reasoning).length !== 2))
        throw new AIServiceClientError('invalid-request');
    if (value.permissions !== undefined && (!Array.isArray(value.permissions) || !value.permissions.length || value.permissions.length > 2 || new Set(value.permissions).size !== value.permissions.length || value.permissions.some(p => !['chat', 'images'].includes(p))))
        throw new AIServiceClientError('invalid-request');
    return structuredClone(value);
}
export function checkedReceipt(value: unknown, appId: string, kind: GrantReceipt['kind']): GrantReceipt {
    const result = GrantReceiptSchema.safeParse(value);
    if (!result.success || result.data.kind !== kind || result.data.scope.appId !== appId)
        throw new AIServiceClientError('permission-denied');
    const r = result.data;
    if (r.revokedAt !== null)
        throw new AIServiceClientError('authorization-revoked');
    if (r.scope.expiresAt !== null && r.scope.expiresAt <= Date.now())
        throw new AIServiceClientError('authorization-expired');
    try {
        if (decodeBase64(r.messageKey).length !== 32 || !new RegExp('^paws_service\\.' + r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.[A-Za-z0-9_-]{43}$').test(r.credential))
            throw 0;
    }
    catch {
        throw new AIServiceClientError('permission-denied');
    }
    return r;
}
export function serviceURL(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    }
    catch {
        throw new AIServiceClientError('invalid-request');
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        throw new AIServiceClientError('invalid-request');
    return url.origin;
}
export async function serviceRequest<T>(fetcher: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(30000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
        if (combined.aborted)
            throw new AIServiceClientError('aborted');
        const response = await fetcher(url, { ...init, signal: combined, redirect: 'error', cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) {
            const error = ServiceErrorSchema.safeParse(data?.error);
            if (error.success)
                throw new AIServiceClientError(error.data.code, error.data.retryable);
            if (data?.error && ['transport-error', 'context-mismatch', 'storage-unavailable', 'disposed', 'aborted', 'observation-expired'].includes(data.error.code) && typeof data.error.retryable === 'boolean')
                throw new AIServiceClientError(data.error.code, data.error.retryable);
            throw new AIServiceClientError('internal-error');
        }
        return data as T;
    }
    catch (error) {
        if (error instanceof AIServiceClientError)
            throw error;
        if (signal?.aborted)
            throw new AIServiceClientError('aborted');
        throw new AIServiceClientError('transport-error', true);
    }
}
export interface OutboxEnvelope {
    requestId: string;
    bindingId: string;
    grantId: string;
    digest: string;
    ciphertext: string;
}
export function createScopedServiceTransport(options: ScopedTransportOptions, kind: GrantReceipt['kind'], initial?: GrantReceipt) {
    const server = serviceURL(options.serverUrl), fetcher = options.fetch ?? globalThis.fetch;
    let receipt: GrantReceipt | null = initial ? checkedReceipt(initial, options.appId, kind) : null, active = false, disposed = false, lifetime = new AbortController();
    const sequences = new Map<string, {
        sequence: number;
        output: string | null;
    }>();
    const knownBindings = new Map<string, ExecutionBinding>();
    function connectionReceipt() { if (disposed)
        throw new AIServiceClientError('disposed'); if (!active || !receipt)
        throw new AIServiceClientError('consent-required'); return checkedReceipt(receipt, options.appId, kind); }
    async function request<T>(path: string, body?: unknown, call?: CallOptions): Promise<T> {
        const r = connectionReceipt(), signal = call?.signal ? AbortSignal.any([call.signal, lifetime.signal]) : lifetime.signal;
        return serviceRequest(fetcher, server + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + r.credential, ...(options.origin ? { Origin: options.origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit' }, signal);
    }
    function parseBinding(value: unknown, expectedId?: string): ExecutionBinding {
        const parsed = ExecutionBindingSchema.safeParse(value), r = connectionReceipt();
        if (!parsed.success)
            throw new AIServiceClientError('context-mismatch');
        const b = parsed.data;
        const tuple = (v: {
            machineId: string;
            engine: string;
            accountRef: unknown;
        }) => canonical([v.machineId, v.engine, v.accountRef]);
        if (b.appId !== options.appId || b.serviceId !== r.scope.serviceId || (expectedId !== undefined && b.id !== expectedId) || !r.scope.targets.some(t => tuple(t) === tuple(b)) || b.permissions.some(p => !r.scope.permissions.includes(p)))
            throw new AIServiceClientError('context-mismatch');
        const known = knownBindings.get(b.id);
        if (known && canonical(known) !== canonical(b))
            throw new AIServiceClientError('context-mismatch');
        knownBindings.set(b.id, b);
        return b;
    }
    function open(ciphertext: string): Record<string, unknown> {
        try {
            const value = decodeBase64(ciphertext), plain = nacl.secretbox.open(value.subarray(24), value.subarray(0, 24), decodeBase64(connectionReceipt().messageKey));
            if (!plain)
                throw 0;
            const parsed = JSON.parse(new TextDecoder().decode(plain));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw 0;
            return parsed;
        }
        catch {
            throw new AIServiceClientError('context-mismatch');
        }
    }
    function record(value: unknown, bindingId: string, requestId?: string, turnId?: string) {
        const parsed = TurnRecordSchema.safeParse(value);
        if (!parsed.success)
            throw new AIServiceClientError('context-mismatch');
        const row = parsed.data;
        parseBinding(row.binding, bindingId);
        if (row.conversationId !== bindingId || (requestId !== undefined && row.requestId !== requestId) || (turnId !== undefined && row.id !== turnId))
            throw new AIServiceClientError('context-mismatch');
        return row;
    }
    function snapshot(value: {
        record: unknown;
        input: string;
        output: string | null;
        sequence: number;
    }, locator: TurnLocator): TurnSnapshot {
        const row = record(value.record, locator.bindingId, locator.requestId, locator.turnId), r = connectionReceipt();
        if (!Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.input !== 'string' || value.input.length > 8 * 1024 * 1024 || (value.output !== null && typeof value.output !== 'string') || value.output !== null && value.sequence === 0 || value.output !== null && value.output.length > 1024 * 1024)
            throw new AIServiceClientError('context-mismatch');
        const context = { protocol: 'ai-services/1', grantId: r.id, appId: options.appId, serviceId: r.scope.serviceId, bindingId: locator.bindingId, requestId: row.requestId };
        const verify = (data: Record<string, unknown>, expected: Record<string, unknown>) => { for (const [key, want] of Object.entries(expected))
            if (data[key] !== want)
                throw new AIServiceClientError('context-mismatch'); };
        const input = open(value.input);
        verify(input, { ...context, direction: 'input', sequence: 0 });
        const messages = validateMessages(input.messages);
        let text = '';
        if (value.output !== null) {
            const output = open(value.output);
            verify(output, { ...context, turnId: row.id, direction: 'output', sequence: value.sequence });
            if (typeof output.text !== 'string')
                throw new AIServiceClientError('context-mismatch');
            text = output.text;
        }
        const previous = sequences.get(row.id);
        if (previous && (value.sequence < previous.sequence || value.sequence === previous.sequence && value.output !== previous.output))
            throw new AIServiceClientError('context-mismatch');
        sequences.set(row.id, { sequence: value.sequence, output: value.output });
        return { record: row, sequence: value.sequence, text, messages };
    }
    const transport: AIServiceTransport = {
        appId: options.appId, source: kind === 'platform-grant' ? 'platform' : 'personal',
        async authorize(input = {}) {
            if (disposed)
                throw new AIServiceClientError('disposed');
            if (input.receipt) {
                if (kind === 'platform-grant' && receipt && input.receipt.id !== receipt.id)
                    throw new AIServiceClientError('permission-denied');
                receipt = checkedReceipt(input.receipt, options.appId, kind);
            }
            if (!receipt)
                throw new AIServiceClientError('consent-required');
            active = true;
            try {
                await transport.list({ signal: input.signal });
                const r = connectionReceipt();
                return { id: r.id, source: transport.source, appId: r.scope.appId, serviceId: r.scope.serviceId, expiresAt: r.scope.expiresAt };
            }
            catch (error) {
                active = false;
                throw error;
            }
        },
        async list(call) { const data = await request<{
            services: unknown[];
            app: unknown;
        }>('/v1/apps/services', undefined, call), r = connectionReceipt(), policy = AppPolicySchema.safeParse(data.app); if (!policy.success || policy.data.appId !== options.appId || !Array.isArray(data.services))
            throw new AIServiceClientError('context-mismatch'); const services = data.services.map(s => { const parsed = ServiceRefSchema.safeParse(s); if (!parsed.success || parsed.data.id !== r.scope.serviceId || parsed.data.ownerId !== r.ownerId)
            throw new AIServiceClientError('context-mismatch'); return parsed.data; }); return { services, app: policy.data }; },
        async readCapabilities(call) { const data = await request<{
            catalog: unknown;
        }>('/v1/apps/ai-services/capabilities', {}, call); if (data.catalog === null)
            return null; const parsed = CapabilityCatalogSchema.safeParse(data.catalog), r = connectionReceipt(); if (!parsed.success || !r.scope.targets.some(t => canonical([t.machineId, t.engine, t.accountRef]) === canonical([parsed.data.machineId, parsed.data.engine, parsed.data.accountRef])))
            throw new AIServiceClientError('context-mismatch'); return parsed.data; },
        async createConversation(input = {}, call) { const overrides = validateOverrides(input.overrides); if (input.appConversationId !== undefined)
            validateIdentifier(input.appConversationId); const result = await request<{
            binding: unknown;
        }>('/v1/apps/ai-services/bindings', { overrides, ...(input.appConversationId === undefined ? {} : { appConversationId: input.appConversationId }) }, call); return parseBinding(result.binding); },
        async findConversation(appConversationId, call) { const data = await request<{
            binding: unknown;
        }>(`/v1/apps/ai-services/conversations/${validateIdentifier(appConversationId)}/binding`, undefined, call); return data.binding === null ? null : parseBinding(data.binding); },
        async start(input: StartTurnInput, call) {
            const binding = parseBinding(input.binding), messages = validateMessages(input.messages), r = connectionReceipt(), requestId = input.requestId ?? globalThis.crypto.randomUUID();
            validateIdentifier(requestId);
            if (messages.some(m => m.images?.length) && !binding.permissions.includes('images'))
                throw new AIServiceClientError('permission-denied');
            const digest = encodeBase64(sha256(new TextEncoder().encode(canonical(messages)))), key = `outbox:${binding.id}:${requestId}`;
            const previous = await options.storage.get<OutboxEnvelope>(key);
            let outbox = previous;
            if (previous && (previous.digest !== digest || previous.grantId !== r.id || previous.bindingId !== binding.id || previous.requestId !== requestId))
                throw new AIServiceClientError('invalid-request');
            if (!outbox) {
                const nonce = getRandomBytes(24), plain = { protocol: 'ai-services/1', grantId: r.id, appId: options.appId, serviceId: r.scope.serviceId, bindingId: binding.id, requestId, direction: 'input', sequence: 0, messages };
                const ciphertext = encodeBase64(new Uint8Array([...nonce, ...nacl.secretbox(new TextEncoder().encode(JSON.stringify(plain)), nonce, decodeBase64(r.messageKey))]));
                if (ciphertext.length > 8 * 1024 * 1024)
                    throw new AIServiceClientError('invalid-request');
                outbox = await options.storage.putIfAbsent(key, { requestId, bindingId: binding.id, grantId: r.id, digest, ciphertext });
                if (outbox.digest !== digest || outbox.grantId !== r.id)
                    throw new AIServiceClientError('invalid-request');
            }
            try {
                if (previous) {
                    try {
                        return await transport.read({ bindingId: binding.id, requestId }, call);
                    }
                    catch (error) {
                        if (!(error instanceof AIServiceClientError) || error.code !== 'invalid-request')
                            throw error;
                    }
                }
                const result = await request<{
                    record: unknown;
                }>(`/v1/apps/ai-services/bindings/${validateIdentifier(binding.id)}/turns`, { requestId, ciphertext: outbox.ciphertext }, call);
                const row = record(result.record, binding.id, requestId);
                return { record: row, sequence: 0, text: '', messages };
            }
            catch (error) {
                if (error instanceof AIServiceClientError)
                    throw new AIServiceClientError(error.code, error.retryable, requestId);
                throw error;
            }
        },
        async read(locator, call) { const base = `/v1/apps/ai-services/bindings/${validateIdentifier(locator.bindingId)}`; const path = locator.turnId ? `${base}/turns/${validateIdentifier(locator.turnId)}` : locator.requestId ? `${base}/requests/${validateIdentifier(locator.requestId)}` : null; if (!path)
            throw new AIServiceClientError('invalid-request'); const value = await request<{
            record: unknown;
            input: string;
            output: string | null;
            sequence: number;
        }>(path, undefined, call); return snapshot(value, locator); },
        async cancel(locator, call) { const result = await request<{
            cancellationRequested: boolean;
            upstreamRetractionGuaranteed: false;
        }>(`/v1/apps/ai-services/bindings/${validateIdentifier(locator.bindingId)}/turns/${validateIdentifier(locator.turnId)}/cancel`, {}, call); if (typeof result.cancellationRequested !== 'boolean' || result.upstreamRetractionGuaranteed !== false)
            throw new AIServiceClientError('context-mismatch'); return result; },
        disconnect() { active = false; lifetime.abort(); lifetime = new AbortController(); sequences.clear(); knownBindings.clear(); if (kind === 'personal-grant')
            receipt = null; },
        revoke: options.revoke ? async (call) => { const r = connectionReceipt(); await options.revoke!(r.id, call); } : undefined,
        dispose() { if (disposed)
            return; transport.disconnect(); receipt = null; disposed = true; lifetime.abort(); },
    };
    return transport;
}
