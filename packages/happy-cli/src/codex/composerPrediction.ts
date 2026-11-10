/** Owns one auxiliary sample per source, with shared subscribers and no history writes. */
import {
    ComposerPredictionRequestSchema, ComposerPredictionCancelSchema,
    type ComposerPredictionRequest, type ComposerPredictionResponse,
} from '@slopus/happy-wire';
import type { CodexAppServerClient } from './codexAppServerClient';

const PREDICTION_PROMPT = `Predict the next message the user is most likely to type, based on the conversation so far.
Return only one short message in the user's voice and language, at most 100 words and 240 characters.
Do not answer the assistant, explain, call tools, invent permission, or expand the user's stated goal.
If the next message is unclear, return exactly <NO_SUGGESTION>.`;

export function createComposerPredictionHandlers(options: {
    client: Pick<CodexAppServerClient, 'threadId' | 'turnId' | 'predictionRevision' | 'sampleThread'>;
    onUnsupported: () => void;
    isBusy: () => boolean;
}) {
    let unsupported = false;
    let current: { key: string; controller: AbortController; subscribers: Set<string>; promise: Promise<ComposerPredictionResponse> } | null = null;
    const cancelled = new Set<string>();

    return {
        async request(input: ComposerPredictionRequest): Promise<ComposerPredictionResponse> {
            const { requestId, sourceTurnId } = ComposerPredictionRequestSchema.parse(input);
            const result = (status: ComposerPredictionResponse['status']): ComposerPredictionResponse => ({ sourceTurnId, status });
            if (unsupported) return result('unsupported');
            if (cancelled.has(requestId) || !options.client.threadId || options.client.turnId || options.isBusy()) return result('stale');
            const key = JSON.stringify([options.client.threadId, options.client.predictionRevision, sourceTurnId]);
            if (current?.key !== key) {
                current?.controller.abort();
                const controller = new AbortController();
                const promise = (async (): Promise<ComposerPredictionResponse> => {
                    try {
                        const response = await options.client.sampleThread(sourceTurnId, PREDICTION_PROMPT, controller.signal);
                        if (controller.signal.aborted || key !== JSON.stringify([options.client.threadId, options.client.predictionRevision, sourceTurnId])
                            || options.client.turnId || options.isBusy() || response.sourceTurnId !== sourceTurnId) return result('stale');
                        const text = response.text?.trim();
                        if (!text || text.includes('<NO_SUGGESTION>') || text.length > 240 || /[\r\n]/.test(text)) return result('none');
                        return { sourceTurnId, status: 'ready', text };
                    } catch (error) {
                        if (error instanceof Error && 'code' in error && error.code === -32601) {
                            unsupported = true;
                            options.onUnsupported();
                            return result('unsupported');
                        }
                        return result(controller.signal.aborted || key !== JSON.stringify([
                            options.client.threadId, options.client.predictionRevision, sourceTurnId,
                        ]) ? 'stale' : 'failed');
                    }
                })();
                current = { key, controller, subscribers: new Set(), promise };
            }
            const entry = current;
            entry.subscribers.add(requestId);
            try {
                const response = await entry.promise;
                return cancelled.has(requestId) || current !== entry ? result('stale') : response;
            } finally {
                entry.subscribers.delete(requestId);
            }
        },
        cancel(input: { requestId: string }): { cancelled: true } {
            const { requestId } = ComposerPredictionCancelSchema.parse(input);
            cancelled.add(requestId);
            if (cancelled.size > 256) cancelled.delete(cancelled.values().next().value!);
            if (current?.subscribers.delete(requestId) && current.subscribers.size === 0) current.controller.abort();
            return { cancelled: true };
        },
    };
}
