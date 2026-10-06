import { beginSubmission, type SubmissionProvenance } from './submission';
import { ServiceConfigurationSchema, ServiceTargetSchema, ExecutionBindingSchema, TurnRecordSchema, CapabilityCatalogSchema, AppPolicySchema, ServiceRefSchema } from '@slopus/happy-wire/ai-services';
import { canonical, serviceRequest, validateIdentifier, validateMessages, validateOverrides } from './scopedTransport';
import { AIServiceClientError, type AIServiceTransport, type CallOptions, type TurnLocator, type TurnSnapshot } from './types';
import type { ServiceStorage } from './storage';
export interface BrowserPlatformOptions {
    appId: string;
    baseUrl: string;
    storage: ServiceStorage;
    fetch?: typeof fetch;
    origin?: string;
    headers?: () => Record<string, string>;
}
/** Application same-origin bridge. It accepts no Paws bearer or message key. Host must enforce login and ownership. */
export function createBrowserPlatformTransport(options: BrowserPlatformOptions): AIServiceTransport {
    const pageLocation = globalThis.location;
    if (pageLocation && options.origin !== undefined && options.origin !== pageLocation.origin)
        throw new AIServiceClientError('permission-denied');
    const origin = pageLocation?.origin ?? options.origin;
    if (!origin)
        throw new AIServiceClientError('invalid-request');
    const base = new URL(options.baseUrl, origin);
    if (base.origin !== origin || base.username || base.password || base.hash || base.search)
        throw new AIServiceClientError('permission-denied');
    let active = false, disposed = false, lifetime = new AbortController(), authorizationEpoch = 0;
    const sequences = new Map<string, {
        sequence: number;
        text: string;
    }>();
    const call = async <T>(path: string, body?: unknown, opts?: CallOptions) => {
        if (disposed)
            throw new AIServiceClientError('disposed');
        if (!active)
            throw new AIServiceClientError('consent-required');
        const headers = options.headers?.() ?? {};
        if (Object.keys(headers).some(k => /authorization|origin/i.test(k)))
            throw new AIServiceClientError('permission-denied');
        return serviceRequest<T>(options.fetch ?? fetch, base.href.replace(/\/$/, '') + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }, opts?.signal ? AbortSignal.any([opts.signal, lifetime.signal]) : lifetime.signal);
    };
    function parseBinding(value: unknown, id?: string) { const b = ExecutionBindingSchema.safeParse(value); if (!b.success || b.data.appId !== options.appId || (id !== undefined && b.data.id !== id))
        throw new AIServiceClientError('context-mismatch'); return b.data; }
    function snapshot(value: TurnSnapshot, locator: TurnLocator) { const row = TurnRecordSchema.safeParse(value?.record); if (!row.success)
        throw new AIServiceClientError('context-mismatch'); parseBinding(row.data.binding, locator.bindingId); if (row.data.conversationId !== locator.bindingId || (locator.turnId && row.data.id !== locator.turnId) || (locator.requestId && row.data.requestId !== locator.requestId) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.text !== 'string')
        throw new AIServiceClientError('context-mismatch'); const messages = validateMessages(value.messages); const last = sequences.get(row.data.id); if (last && (value.sequence < last.sequence || value.sequence === last.sequence && value.text !== last.text))
        throw new AIServiceClientError('context-mismatch'); sequences.set(row.data.id, { sequence: value.sequence, text: value.text }); return { record: row.data, sequence: value.sequence, text: value.text, messages }; }
    const transport: AIServiceTransport = {
        appId: options.appId, source: 'platform',
        async authorize(input = {}) { if (input.receipt)
            throw new AIServiceClientError('permission-denied'); const epoch = ++authorizationEpoch; active = true; try {
            const result = await call<any>('/connection', undefined, input);
            if (disposed || epoch !== authorizationEpoch) throw new AIServiceClientError('aborted');
            if (result.source !== 'platform' || result.appId !== options.appId || typeof result.id !== 'string' || typeof result.serviceId !== 'string' || result.expiresAt !== null && !Number.isFinite(result.expiresAt) || Object.keys(result).some(k => !['id', 'source', 'appId', 'serviceId', 'expiresAt'].includes(k)))
                throw new AIServiceClientError('context-mismatch');
            return result;
        }
        catch (error) {
            if (epoch === authorizationEpoch) active = false;
            throw error;
        } },
        async list(opts) { const data = await call<any>('/services', undefined, opts), app = AppPolicySchema.safeParse(data.app); if (!app.success || app.data.appId !== options.appId || !Array.isArray(data.services))
            throw new AIServiceClientError('context-mismatch'); return { app: app.data, services: data.services.map((s: unknown) => { const parsed = ServiceRefSchema.safeParse(s); if (!parsed.success)
                throw new AIServiceClientError('context-mismatch'); return parsed.data; }) }; },
        async configuration(opts) { const data = ServiceConfigurationSchema.safeParse(await call('/configuration', undefined, opts)); if (!data.success) throw new AIServiceClientError('context-mismatch'); return data.data; },
        async readCapabilities(opts) { if (opts?.target !== undefined && !ServiceTargetSchema.safeParse(opts.target).success) throw new AIServiceClientError('invalid-request'); const data = await call<any>('/capabilities', opts?.target ? {target:opts.target} : {}, opts); if (data.catalog === null)
            return null; const parsed = CapabilityCatalogSchema.safeParse(data.catalog); if (!parsed.success)
            throw new AIServiceClientError('context-mismatch'); if (opts?.target && canonical([opts.target.machineId,opts.target.engine,opts.target.accountRef]) !== canonical([parsed.data.machineId,parsed.data.engine,parsed.data.accountRef])) throw new AIServiceClientError('context-mismatch'); return parsed.data; },
        async createConversation(input = {}, opts) { const overrides = validateOverrides(input.overrides); if (input.appConversationId !== undefined)
            validateIdentifier(input.appConversationId); const data = await call<any>('/conversations', { overrides, ...(input.appConversationId === undefined ? {} : { appConversationId: input.appConversationId }) }, opts); return parseBinding(data.binding); },
        async findConversation(id, opts) { const data = await call<any>(`/conversations/${validateIdentifier(id)}/binding`, undefined, opts); return data.binding === null ? null : parseBinding(data.binding); },
        async start(input, opts) {
            const binding = parseBinding(input.binding), messages = validateMessages(input.messages), requestId = input.requestId ?? crypto.randomUUID();
            validateIdentifier(requestId);
            const key = `bridge-outbox:${binding.id}:${requestId}`, digest = canonical(messages);
            const attemptId = crypto.randomUUID();
            const saved = await options.storage.get<SubmissionProvenance & {
                requestId: string;
                digest: string;
            }>(key);
            // Browser outbox contains a digest and ID only. The backend persists the original encrypted envelope.
            const { sha256 } = await import('@noble/hashes/sha256');
            const hash = Array.from(sha256(new TextEncoder().encode(digest)), b => b.toString(16).padStart(2, '0')).join('');
            if (saved && saved.digest !== hash)
                throw new AIServiceClientError('invalid-request');
            const outbox = await options.storage.putIfAbsent(key, { requestId, digest: hash, admissionOwner: attemptId });
            if (outbox.digest !== hash)
                throw new AIServiceClientError('invalid-request');
            const submission = await beginSubmission(options.storage, key, outbox, attemptId, requestId);
            try {
                if (saved) {
                    try {
                        return await transport.read({ bindingId: binding.id, requestId }, opts);
                    }
                    catch (error) {
                        if (!(error instanceof AIServiceClientError) || error.code !== 'invalid-request')
                            throw error;
                    }
                }
                const data = await call<TurnSnapshot>(`/bindings/${validateIdentifier(binding.id)}/turns`, { requestId, messages }, opts);
                return snapshot(data, { bindingId: binding.id, requestId });
            }
            catch (error) {
                throw await submission.failure(error);
            }
        },
        async read(locator, opts) { const basePath = `/bindings/${validateIdentifier(locator.bindingId)}`; const path = locator.turnId ? `${basePath}/turns/${validateIdentifier(locator.turnId)}` : locator.requestId ? `${basePath}/requests/${validateIdentifier(locator.requestId)}` : null; if (!path)
            throw new AIServiceClientError('invalid-request'); return snapshot(await call<TurnSnapshot>(path, undefined, opts), locator); },
        cancel(locator, opts) { return call(`/bindings/${validateIdentifier(locator.bindingId)}/turns/${validateIdentifier(locator.turnId)}/cancel`, {}, opts); },
        async revoke(opts) { await call('/revoke', {}, opts); },
        disconnect() { authorizationEpoch++; active = false; lifetime.abort(); lifetime = new AbortController(); sequences.clear(); },
        dispose() { if (disposed)
            return; transport.disconnect(); disposed = true; lifetime.abort(); },
    };
    return transport;
}
