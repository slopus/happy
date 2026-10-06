import type { AppPolicy, CapabilityCatalog, ExecutionBinding, GrantReceipt, ServiceErrorCode, ServicePermission, ServiceReasoning, ServiceRef, ServiceTarget, ServicePermissionMode, ServiceTier, ServiceConfiguration, ServiceConfig, TurnRecord } from '@slopus/happy-wire/ai-services';
export type { AppPolicy, CapabilityCatalog, ExecutionBinding, GrantReceipt, ServiceGrant, ServiceErrorCode, ServicePermission, ServiceReasoning, ServiceRef, ServiceTarget, ServicePermissionMode, ServiceTier, ServiceConfiguration, ServiceConfig, TurnRecord, TurnActual } from '@slopus/happy-wire/ai-services';
export type ServiceSource = 'platform' | 'personal';
export type ClientErrorCode = ServiceErrorCode | 'transport-error' | 'context-mismatch' | 'storage-unavailable' | 'disposed' | 'aborted' | 'observation-expired';
export class AIServiceClientError extends Error {
    constructor(readonly code: ClientErrorCode, readonly retryable = false, readonly requestId?: string, readonly submission: 'uncertain' | 'not-submitted' = 'uncertain') { super(code); this.name = 'AIServiceClientError'; }
}
export interface ServiceConnection {
    id: string;
    source: ServiceSource;
    appId: string;
    serviceId: string;
    expiresAt: number | null;
}
export interface ServiceMessage {
    role: 'user' | 'assistant';
    text: string;
    images?: string[];
}
export interface BindingOverrides {
    target?: ServiceTarget;
    permissionMode?: ServicePermissionMode;
    serviceTier?: ServiceTier;
    modelId?: string | null;
    reasoning?: ServiceReasoning;
    permissions?: ServicePermission[];
}
export interface CreateConversationInput {
    appConversationId?: string;
    overrides?: BindingOverrides;
}
export interface StartTurnInput {
    binding: ExecutionBinding;
    requestId?: string;
    messages: ServiceMessage[];
}
export interface TurnLocator {
    bindingId: string;
    turnId?: string;
    requestId?: string;
}
export interface TurnSnapshot {
    record: TurnRecord;
    sequence: number;
    text: string;
    messages: ServiceMessage[];
}
export interface AuthorizationPending {
    id: string;
    expiresAt: number;
    approvalUrl: string;
    qrUrl: string;
}
export interface AuthorizeOptions {
    receipt?: GrantReceipt;
    signal?: AbortSignal;
    onPending?: (pending: AuthorizationPending) => void;
}
export interface CallOptions {
    signal?: AbortSignal;
}
export interface CapabilityReadOptions extends CallOptions { target?: ServiceTarget; }
export interface ServiceList {
    services: ServiceRef[];
    app: AppPolicy;
}
export interface AIServiceTransport {
    readonly appId: string;
    readonly source: ServiceSource;
    authorize(options?: AuthorizeOptions): Promise<ServiceConnection>;
    list(options?: CallOptions): Promise<ServiceList>;
    configuration?(options?: CallOptions): Promise<ServiceConfiguration>;
    readCapabilities(options?: CapabilityReadOptions): Promise<CapabilityCatalog | null>;
    createConversation(input?: CreateConversationInput, options?: CallOptions): Promise<ExecutionBinding>;
    findConversation(appConversationId: string, options?: CallOptions): Promise<ExecutionBinding | null>;
    start(input: StartTurnInput, options?: CallOptions): Promise<TurnSnapshot>;
    read(locator: TurnLocator, options?: CallOptions): Promise<TurnSnapshot>;
    cancel(locator: TurnLocator & {
        turnId: string;
    }, options?: CallOptions): Promise<{
        cancellationRequested: boolean;
        upstreamRetractionGuaranteed: false;
    }>;
    disconnect(): void;
    /** Requires an explicitly configured owner/host revocation hook; a scoped bearer is insufficient. */
    revoke?(options?: CallOptions): Promise<void>;
    dispose(): void;
}
export type TurnObservationEvent = {
    type: 'snapshot';
    snapshot: TurnSnapshot;
} | {
    type: 'error';
    error: AIServiceClientError;
};
export interface ObserveOptions extends TurnLocator {
    signal?: AbortSignal;
    afterSequence?: number;
    maxDurationMs?: number;
    intervalMs?: number;
}
export interface TurnSubscription {
    done: Promise<void>;
    unsubscribe(): void;
}
