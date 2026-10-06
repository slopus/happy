import { ServiceErrorCodeSchema } from '@slopus/happy-wire/ai-services';
import { AIServiceClientError } from './types';
import type { ServiceStorage } from './storage';

type Outcome = { state: 'uncertain' } | {
    state: 'rejected'; requestId: string; code: string; retryable: boolean;
};
export interface SubmissionProvenance { admissionOwner?: string }

/** All callers sharing an outbox must use this protocol. Never expire/remove its
 * outcome while that outbox can retry. putIfAbsent must be atomic across handles.
 *
 * Only the outbox creator can prove refusal. Before any other caller may POST,
 * it must win/read the same immutable outcome slot as "uncertain". If the creator
 * wins "rejected" first, those callers cannot POST. If a contender wins, no caller
 * can ever report not-submitted. A crash leaves recoverable uncertainty, not a lease.
 */
export async function beginSubmission(storage: ServiceStorage, outboxKey: string,
    provenance: SubmissionProvenance, attemptId: string, requestId: string) {
    const outcomeKey = outboxKey + ':admission-outcome-v1';
    const owner = provenance.admissionOwner === attemptId;
    const rejection = (outcome: Outcome): AIServiceClientError | null => {
        if (outcome.state !== 'rejected') return null;
        const code = ServiceErrorCodeSchema.safeParse(outcome.code);
        if (!code.success || outcome.requestId !== requestId || typeof outcome.retryable !== 'boolean')
            throw new AIServiceClientError('context-mismatch', false, requestId);
        return new AIServiceClientError(code.data, outcome.retryable, requestId, 'not-submitted');
    };
    if (!owner) {
        // Includes legacy outboxes, which have no creator provenance. It is unsafe
        // to infer their history from a missing outcome or a missing HTTP result.
        const outcome = await storage.putIfAbsent<Outcome>(outcomeKey, { state: 'uncertain' });
        const refused = rejection(outcome);
        if (refused) throw refused;
        if (outcome.state !== 'uncertain') throw new AIServiceClientError('context-mismatch', false, requestId);
    }
    return {
        async failure(error: unknown): Promise<AIServiceClientError> {
            const safe = error instanceof AIServiceClientError ? error : new AIServiceClientError('transport-error', true);
            const proven = owner && safe.submission === 'not-submitted' && safe.requestId === requestId
                && ServiceErrorCodeSchema.safeParse(safe.code).success;
            const outcome = await storage.putIfAbsent<Outcome>(outcomeKey, proven
                ? { state: 'rejected', requestId, code: safe.code, retryable: safe.retryable }
                : { state: 'uncertain' });
            const refused = rejection(outcome);
            if (refused) return refused;
            return new AIServiceClientError(safe.code, safe.retryable, requestId);
        },
    };
}
