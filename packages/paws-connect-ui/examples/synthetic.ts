// Public synthetic data. No network, receipts, keys, or production state machine.
import { AIServiceClientError, createAIServiceClient, createServiceController, createMemoryServiceStorage,
    type AIServiceTransport, type AuthorizationPending, type AuthorizeOptions, type CapabilityCatalog, type ClientErrorCode, type ServiceSource } from '@wangjs-jacky/paws-agent/services/browser';

export const syntheticCatalog: CapabilityCatalog = {
    protocol: 'ai-services/1', engine: 'codex', machineId: 'demo-device', accountRef: { kind: 'codex-profile', id: 'demo-account' },
    observedAt: 1791230400000, availability: 'online', completeness: 'complete', defaultModelId: 'catalog-default',
    models: [
        { id: 'catalog-default', name: 'Catalog native default', supportsImages: true, reasoning: { supportsDefault: true, values: ['low', 'high'], defaultValue: 'high' } },
        { id: 'basic', name: 'Basic model', supportsImages: false, reasoning: { supportsDefault: true, values: [], defaultValue: null } },
    ],
};
export function createSyntheticController({ approvalUrl = 'https://example.invalid/approve?id=demo' }: { approvalUrl?: string } = {}) {
    let catalog = structuredClone(syntheticCatalog), error: ClientErrorCode | null = null;
    let pending: AuthorizeOptions | null = null;
    let approval: (() => void) | null = null;
    let delayedRead: (() => void) | null = null;
    let delay = false;
    function transport(source: ServiceSource): AIServiceTransport {
        return {
            appId: 'public-demo', source,
            async authorize(options = {}) {
                if (error) throw new AIServiceClientError(error, error === 'machine-offline' || error === 'resource-busy');
                if (source === 'personal') {
                    pending = options;
                    options.onPending?.({ id: 'demo-pairing', expiresAt: Date.now() + 600000, approvalUrl, qrUrl: 'paws:///apps/authorize?id=demo&protocol=ai-services%2F1' });
                    await new Promise<void>((resolve, reject) => {
                        approval = resolve;
                        options.signal?.addEventListener('abort', () => reject(new AIServiceClientError('aborted')), { once: true });
                    });
                }
                return { id: `${source}-demo-connection`, source, appId: 'public-demo', serviceId: `${source}-demo-service`, expiresAt: null };
            },
            async readCapabilities() {
                const observed = structuredClone(catalog);
                if (delay) await new Promise<void>(resolve => delayedRead = resolve);
                if (error) throw new AIServiceClientError(error, false);
                return observed;
            },
            async list() { return { services: [], app: { appId: 'public-demo', name: 'Public demo', origins: ['https://example.invalid'], capabilities: ['chat'], businessPrompt: { id: 'demo', version: '1' } } }; },
            async createConversation() { throw new AIServiceClientError('invalid-request'); },
            async findConversation() { return null; },
            async start() { throw new AIServiceClientError('invalid-request'); },
            async read() { throw new AIServiceClientError('invalid-request'); },
            async cancel() { throw new AIServiceClientError('invalid-request'); },
            disconnect() {}, dispose() {},
        };
    }
    const storage = createMemoryServiceStorage();
    let warning: 'remember-unavailable' | 'session-unavailable' | null = null;
    storage.getStatus = () => ({ mode: 'memory', warning });
    const controller = createServiceController({
        platform: createAIServiceClient({ appId: 'public-demo', transport: transport('platform') }),
        personal: createAIServiceClient({ appId: 'public-demo', transport: transport('personal') }),
    }, storage);
    return {
        controller,
        setCatalog(value: CapabilityCatalog) { catalog = structuredClone(value); },
        setError(value: ClientErrorCode | null) { error = value; },
        setStorageWarning(value: 'remember-unavailable' | 'session-unavailable') { warning = value; },
        approve() { approval?.(); },
        emitOldPending() { pending?.onPending?.({ id: 'old', expiresAt: Date.now() + 60000, approvalUrl: 'https://example.invalid/old', qrUrl: 'paws:///old' }); },
        emitPending(value: AuthorizationPending) { pending?.onPending?.(value); },
        delayRead() { delay = true; },
        finishRead() { delay = false; delayedRead?.(); },
    };
}
