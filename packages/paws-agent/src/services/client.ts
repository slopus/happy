import { AIServiceClientError, type AIServiceTransport, type ObserveOptions, type TurnObservationEvent, type TurnSubscription, type TurnSnapshot } from './types';
export function safeServiceError(error: unknown): AIServiceClientError { return error instanceof AIServiceClientError ? error : new AIServiceClientError('transport-error', true); }
export function waitForServicePoll(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new AIServiceClientError('aborted'));
            return;
        }
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new AIServiceClientError('aborted')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}
export function createAIServiceClient({ appId, transport }: {
    appId: string;
    transport: AIServiceTransport;
}) {
    if (!appId || transport.appId !== appId)
        throw new AIServiceClientError('permission-denied');
    let disposed = false;
    const subscriptions = new Set<AbortController>();
    const open = () => { if (disposed)
        throw new AIServiceClientError('disposed'); };
    const terminal = (snapshot: TurnSnapshot) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.record.status);
    return {
        appId, source: transport.source,
        services: { list: (...args: Parameters<AIServiceTransport['list']>) => { open(); return transport.list(...args); } },
        capabilities: { read: (...args: Parameters<AIServiceTransport['readCapabilities']>) => { open(); return transport.readCapabilities(...args); } },
        connections: {
            authorize: (...args: Parameters<AIServiceTransport['authorize']>) => { open(); return transport.authorize(...args); },
            disconnect() { open(); for (const controller of subscriptions)
                controller.abort(); transport.disconnect(); },
            async revoke(...args: Parameters<NonNullable<AIServiceTransport['revoke']>>) { open(); if (!transport.revoke)
                throw new AIServiceClientError('permission-denied'); await transport.revoke(...args); for (const controller of subscriptions)
                controller.abort(); transport.disconnect(); },
        },
        conversations: { create: (...args: Parameters<AIServiceTransport['createConversation']>) => { open(); return transport.createConversation(...args); }, find: (...args: Parameters<AIServiceTransport['findConversation']>) => { open(); return transport.findConversation(...args); } },
        turns: {
            start: (...args: Parameters<AIServiceTransport['start']>) => { open(); return transport.start(...args); },
            read: (...args: Parameters<AIServiceTransport['read']>) => { open(); return transport.read(...args); },
            cancel: (...args: Parameters<AIServiceTransport['cancel']>) => { open(); return transport.cancel(...args); },
            observe(options: ObserveOptions, listener: (event: TurnObservationEvent) => void): TurnSubscription {
                open();
                const maxDuration = Math.min(options.maxDurationMs ?? 300000, 300000), interval = Math.max(250, Math.min(options.intervalMs ?? 1000, 10000));
                if (!Number.isFinite(maxDuration) || maxDuration <= 0 || !Number.isSafeInteger(options.afterSequence ?? 0) || (options.afterSequence ?? 0) < 0)
                    throw new AIServiceClientError('invalid-request');
                const controller = new AbortController();
                let expired = false;
                const expiryTimer = setTimeout(() => { expired = true; controller.abort(); }, maxDuration);
                subscriptions.add(controller);
                const externalAbort = () => controller.abort();
                options.signal?.addEventListener('abort', externalAbort, { once: true });
                if (options.signal?.aborted)
                    controller.abort();
                const deadline = Date.now() + maxDuration;
                let sequence = options.afterSequence ?? -1, signature = '', failures = 0;
                const done = (async () => {
                    try {
                        while (!controller.signal.aborted && Date.now() < deadline) {
                            try {
                                const snapshot = await transport.read(options, { signal: controller.signal });
                                if (controller.signal.aborted)
                                    return;
                                if (snapshot.sequence < sequence)
                                    throw new AIServiceClientError('context-mismatch');
                                const next = JSON.stringify([snapshot.sequence, snapshot.record]);
                                if (next !== signature) {
                                    sequence = snapshot.sequence;
                                    signature = next;
                                    listener({ type: 'snapshot', snapshot });
                                }
                                if (terminal(snapshot))
                                    return;
                                failures = 0;
                            }
                            catch (error) {
                                if (controller.signal.aborted)
                                    return;
                                const safe = safeServiceError(error);
                                listener({ type: 'error', error: safe });
                                if (!safe.retryable || ++failures >= 5)
                                    return;
                            }
                            await waitForServicePoll(Math.min(interval * 2 ** failures, 10000, Math.max(0, deadline - Date.now())), controller.signal);
                        }

                    }
                    catch (error) {
                        if (!controller.signal.aborted)
                            listener({ type: 'error', error: safeServiceError(error) });
                    }
                    finally {
                        clearTimeout(expiryTimer);
                        if (expired) listener({ type: 'error', error: new AIServiceClientError('observation-expired', true) });
                        subscriptions.delete(controller);
                        options.signal?.removeEventListener('abort', externalAbort);
                    }
                })();
                return { done, unsubscribe: () => controller.abort() };
            },
        },
        dispose() { if (disposed)
            return; disposed = true; for (const controller of subscriptions)
            controller.abort(); subscriptions.clear(); transport.dispose(); },
    };
}
export type AIServiceClient = ReturnType<typeof createAIServiceClient>;
