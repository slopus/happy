import {
    createPublicShareRateLimiter,
    type RedisEval,
} from './publicSessionShareRateLimit';

export const PUBLIC_SESSION_COVER_ACCOUNT_RATE_MAX = 20;
export const PUBLIC_SESSION_COVER_GLOBAL_RATE_MAX = 180;
export const PUBLIC_SESSION_COVER_RATE_WINDOW_MS = 60 * 60 * 1000;
export const PUBLIC_SESSION_COVER_ACCOUNT_CONCURRENCY = 2;
export const PUBLIC_SESSION_COVER_GLOBAL_CONCURRENCY = 4;
const CONCURRENCY_RETRY_AFTER_SECONDS = 1;

export class PublicSessionCoverAvailabilityError extends Error {
    override readonly name = 'PublicSessionCoverAvailabilityError';

    constructor(readonly retryAfterSeconds: number) {
        super('Cover provider is busy');
    }
}

export function createPublicSessionCoverAvailability(options: {
    accountRateMax?: number;
    globalRateMax?: number;
    rateWindowMs?: number;
    accountConcurrency?: number;
    globalConcurrency?: number;
    redisEval?: RedisEval | null;
} = {}) {
    const accountRate = createPublicShareRateLimiter({
        scope: 'cover-provider-account',
        max: options.accountRateMax ?? PUBLIC_SESSION_COVER_ACCOUNT_RATE_MAX,
        windowMs: options.rateWindowMs ?? PUBLIC_SESSION_COVER_RATE_WINDOW_MS,
        redisEval: options.redisEval,
    });
    const globalRate = createPublicShareRateLimiter({
        scope: 'cover-provider-global',
        max: options.globalRateMax ?? PUBLIC_SESSION_COVER_GLOBAL_RATE_MAX,
        windowMs: options.rateWindowMs ?? PUBLIC_SESSION_COVER_RATE_WINDOW_MS,
        redisEval: options.redisEval,
    });
    const accountConcurrency = options.accountConcurrency ?? PUBLIC_SESSION_COVER_ACCOUNT_CONCURRENCY;
    const globalConcurrency = options.globalConcurrency ?? PUBLIC_SESSION_COVER_GLOBAL_CONCURRENCY;
    const activeByAccount = new Map<string, number>();
    let activeGlobal = 0;

    const acquire = async (accountId: string): Promise<() => void> => {
        const accountBudget = await accountRate.check(accountId);
        if (!accountBudget.allowed) {
            throw new PublicSessionCoverAvailabilityError(accountBudget.retryAfterSeconds);
        }
        const globalBudget = await globalRate.check('pexels');
        if (!globalBudget.allowed) {
            throw new PublicSessionCoverAvailabilityError(globalBudget.retryAfterSeconds);
        }

        const activeForAccount = activeByAccount.get(accountId) ?? 0;
        if (activeForAccount >= accountConcurrency || activeGlobal >= globalConcurrency) {
            throw new PublicSessionCoverAvailabilityError(CONCURRENCY_RETRY_AFTER_SECONDS);
        }
        activeByAccount.set(accountId, activeForAccount + 1);
        activeGlobal += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            activeGlobal -= 1;
            const remainingForAccount = (activeByAccount.get(accountId) ?? 1) - 1;
            if (remainingForAccount === 0) activeByAccount.delete(accountId);
            else activeByAccount.set(accountId, remainingForAccount);
        };
    };

    return {
        acquire,
        async run<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
            const release = await acquire(accountId);
            try {
                return await operation();
            } finally {
                release();
            }
        },
    };
}
