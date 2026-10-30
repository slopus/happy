/**
 * Asks a Workers Rate Limiting binding whether `key` may proceed. A missing
 * binding (tests, local dev) allows everything, and so does a limiter error:
 * a broken limiter must not take push delivery down with it.
 */
export async function isWithinLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
    if (!limiter) {
        return true;
    }
    try {
        const { success } = await limiter.limit({ key });
        return success;
    } catch (error) {
        console.error(`push: rate limiter failed, allowing: ${error instanceof Error ? error.message : String(error)}`);
        return true;
    }
}
