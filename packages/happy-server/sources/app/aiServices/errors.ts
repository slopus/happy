import type { ServiceErrorCode } from '@slopus/happy-wire';

export class AIServiceError extends Error {
    constructor(public readonly code: ServiceErrorCode, public readonly retryable = false) { super(code); }
}
export function deny(code: ServiceErrorCode): never { throw new AIServiceError(code); }

/** Stable HTTP 413 lets a native worker publish its small terminal snapshot marker. */
export class AIServicePayloadTooLargeError extends AIServiceError {
    constructor() { super('invalid-request'); }
}
