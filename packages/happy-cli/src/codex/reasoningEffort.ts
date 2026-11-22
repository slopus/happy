import type { ReasoningEffort } from './codexAppServerTypes';

/** Validate remote effort overrides before forwarding them to Codex. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value);
}
