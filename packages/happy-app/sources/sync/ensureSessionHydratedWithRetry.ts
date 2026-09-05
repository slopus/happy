import { sync } from './sync';

const SESSION_HYDRATION_DELAYS_MS = [0, 100, 250, 500] as const;

/**
 * Resolve a short read-after-create race without decrypting the account's
 * session history. The first attempt also covers the socket-event fast path
 * because ensureSessionHydrated checks local state before issuing a request.
 */
export async function ensureSessionHydratedWithRetry(sessionId: string): Promise<boolean> {
    for (const delayMs of SESSION_HYDRATION_DELAYS_MS) {
        if (delayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
        try {
            if (await sync.ensureSessionHydrated(sessionId)) {
                return true;
            }
        } catch {
            // Keep retries bounded to this one session. Callers decide how to
            // surface an exhausted hydration attempt.
        }
    }
    return false;
}
