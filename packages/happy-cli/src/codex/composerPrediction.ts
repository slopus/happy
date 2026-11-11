/** Owns one auxiliary sample per source, with shared subscribers and no history writes. */
import {
    ComposerPredictionRequestSchema, ComposerPredictionCancelSchema,
    type ComposerPredictionRequest, type ComposerPredictionResponse,
} from '@slopus/happy-wire';
import type { CodexAppServerClient } from './codexAppServerClient';

const PREDICTION_PROMPT = `Suggest the user's next message using the current conversation and their established goal.
Focus on the latest unresolved question, decision or concrete next step. Write a useful, directly editable draft in the user's voice and language, preserving relevant requirements, fallback conditions and execution boundaries they have already expressed.
Use up to three natural sentences in one plain-text paragraph, at most 240 characters. Include the specific object, action and important constraints when the context supports them; do not shorten the draft into a vague acknowledgement.
Do not answer as the assistant, explain the suggestion, call tools, repeat the assistant's reply, or invent facts, preferences, requirements, permission to act or additional tasks. Do not choose an option merely because the assistant recommends it; the user's own stated preferences must support the choice.
Return exactly <NO_SUGGESTION> if there is no specific, well-supported follow-up, the work is finished, or only a generic acknowledgement such as "okay", "continue" or "keep optimizing" would fit.
Return only the draft or <NO_SUGGESTION>.`;

// A narrow fallback for obvious filler; concrete short instructions and option
// labels remain eligible. Context/intent grounding is the sampler prompt's job.
const GENERIC_PREDICTIONS = new Set([
    'ok', 'okay', 'yes', 'sure', 'thanks', 'thankyou', 'gotit', 'understood',
    'soundsgood', 'continue', 'continueplease', 'goahead', 'proceed', 'keepgoing',
    'keepoptimizing', 'continueoptimizing', 'optimizeitmore',
    '好', '好的', '好啊', '好呀', '行', '可以', '明白', '明白了', '收到', '知道了',
    '嗯', '嗯嗯', '谢谢', '继续', '继续吧', '请继续', '继续优化', '继续优化一下',
    '再优化一下', '进一步优化', '帮我优化一下',
]);

function isGenericPrediction(text: string): boolean {
    return GENERIC_PREDICTIONS.has(text.toLowerCase().replace(/[\s.!?。！？,，;；:：…]/gu, ''));
}

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
                        const text = response.text?.replace(/\s+/gu, ' ').trim();
                        if (!text || text.includes('<NO_SUGGESTION>') || text.length > 240 || isGenericPrediction(text)) return result('none');
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
