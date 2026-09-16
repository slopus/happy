import { assertAccountRuntime } from './accountRuntime';

const pending = new Set<AbortController>();
let installed = false;
// Account cleanup may use the original transport with its captured old credentials.
export const accountCleanupFetch: typeof fetch = (...args) => originalFetch(...args);
const originalFetch = globalThis.fetch.bind(globalThis);
export function installAccountNetworkGuard(): void {
    if (installed) return;
    installed = true;
    globalThis.fetch = async (input, init) => {
        assertAccountRuntime();
        const controller = new AbortController();
        const source = init?.signal || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
        const abort = () => controller.abort();
        if (source?.aborted) abort();
        source?.addEventListener('abort', abort, { once: true });
        pending.add(controller);
        try {
            const response = await originalFetch(input, { ...init, signal: controller.signal });
            assertAccountRuntime();
            return response;
        } finally {
            pending.delete(controller);
            source?.removeEventListener('abort', abort);
        }
    };
}
export function abortAccountRequests(): void {
    for (const controller of pending) controller.abort();
    pending.clear();
}
