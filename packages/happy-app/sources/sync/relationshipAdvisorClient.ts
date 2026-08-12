import { apiSocket } from './apiSocket';

export interface RelationshipAdvisorMessage {
    role: 'user' | 'assistant';
    text: string;
}

export interface RelationshipAdvisorStartRequest {
    requestId: string;
    messages: RelationshipAdvisorMessage[];
    imageRefs: string[];
}

export type RelationshipAdvisorEvent =
    | { requestId: string; type: 'accepted' }
    | { requestId: string; type: 'delta'; text: string }
    | { requestId: string; type: 'done' }
    | { requestId: string; type: 'error'; error: string };

interface RelationshipAdvisorTransport {
    onMessage: (event: string, listener: (data: any) => void) => () => void;
    onStatusChange: (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => () => void;
    emitWithAck: (event: string, data: any) => Promise<unknown>;
    send: (event: string, data: any) => boolean;
}

type RelationshipAdvisorConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export class RelationshipAdvisorClient {
    constructor(
        private readonly transport: RelationshipAdvisorTransport = apiSocket,
        private readonly acknowledgementTimeoutMs = 10_000,
        private readonly streamTimeoutMs = 130_000,
    ) {}

    async start(
        request: RelationshipAdvisorStartRequest,
        onEvent: (event: RelationshipAdvisorEvent) => void,
    ): Promise<() => void> {
        let acknowledged = false;
        let ended = false;
        let streamTimeout: ReturnType<typeof setTimeout> | undefined;
        const connectionState: { current: RelationshipAdvisorConnectionStatus } = { current: 'connecting' };
        let unsubscribeStatus = () => {};

        const cleanup = () => {
            if (ended) return;
            ended = true;
            unsubscribeEvent();
            unsubscribeStatus();
            if (streamTimeout) clearTimeout(streamTimeout);
        };
        const failStream = () => {
            if (ended) return;
            onEvent({
                requestId: request.requestId,
                type: 'error',
                error: 'Relationship advisor is temporarily unavailable',
            });
            cleanup();
        };
        const unsubscribeEvent = this.transport.onMessage('relationship-advisor:event', (event: RelationshipAdvisorEvent) => {
            if (event.requestId !== request.requestId || ended) return;
            onEvent(event);
            if (event.type === 'done' || event.type === 'error') cleanup();
        });
        unsubscribeStatus = this.transport.onStatusChange((status) => {
            connectionState.current = status;
            if (acknowledged && (status === 'disconnected' || status === 'error')) failStream();
        });
        let response: { ok: true } | { ok: false; error: string };
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            response = await Promise.race([
                this.transport.emitWithAck('relationship-advisor:start', request),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error('Relationship advisor start timed out')), this.acknowledgementTimeoutMs);
                }),
            ]) as { ok: true } | { ok: false; error: string };
        } catch (error) {
            cleanup();
            throw error;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
        if (!response || typeof response.ok !== 'boolean') {
            cleanup();
            throw new Error('Invalid relationship advisor acknowledgement');
        }
        if (!response.ok) {
            cleanup();
            throw new Error(response.error);
        }
        acknowledged = true;
        if (connectionState.current === 'disconnected' || connectionState.current === 'error') {
            failStream();
        } else if (!ended) {
            streamTimeout = setTimeout(failStream, this.streamTimeoutMs);
        }
        return cleanup;
    }

    cancel(requestId: string) {
        this.transport.send('relationship-advisor:cancel', { requestId });
    }
}

export const relationshipAdvisorClient = new RelationshipAdvisorClient();
