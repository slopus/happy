import type { Metadata } from './storageTypes';
import { isRigMetadataV1 } from './rig';

/** How a message sent while the agent is running reaches it. */
export type FollowUpDelivery = 'steer' | 'queue';

/**
 * The `followUpBehavior` setting, named as on desktop. The first two pick what
 * plain Send does and let the alternate gesture (long-press on touch, ⌘↵ or
 * Ctrl+Enter on web) do the other; the `always` pair locks both to one.
 */
export const FOLLOW_UP_BEHAVIORS = ['steer', 'queue', 'alwaysSteer', 'alwaysQueue'] as const;
export type FollowUpBehavior = typeof FOLLOW_UP_BEHAVIORS[number];

/**
 * The capability a Happy Agent daemon advertises once it honors
 * `meta.delivery` from the phone. Until a daemon sets it, the app sends no
 * delivery field and hides every Steer/Queue control, so behavior is unchanged.
 */
export const FOLLOW_UP_QUEUEING_CAPABILITY = 'queueing';

export type FollowUpDeliveries = {
    /** The send button, Enter, and every send that names no delivery. */
    plain: FollowUpDelivery;
    /** Long-press on the send button, or ⌘↵ / Ctrl+Enter on web. */
    alternate: FollowUpDelivery;
};

/** Unknown or missing values, such as one from a newer build, mean the default. */
export function normalizeFollowUpBehavior(value: unknown): FollowUpBehavior {
    return FOLLOW_UP_BEHAVIORS.includes(value as FollowUpBehavior) ? value as FollowUpBehavior : 'steer';
}

export function resolveFollowUpDeliveries(behavior: unknown): FollowUpDeliveries {
    switch (normalizeFollowUpBehavior(behavior)) {
        case 'queue': return { plain: 'queue', alternate: 'steer' };
        case 'alwaysSteer': return { plain: 'steer', alternate: 'steer' };
        case 'alwaysQueue': return { plain: 'queue', alternate: 'queue' };
        default: return { plain: 'steer', alternate: 'queue' };
    }
}

export function resolveFollowUpDelivery(behavior: unknown, gesture: keyof FollowUpDeliveries): FollowUpDelivery {
    return resolveFollowUpDeliveries(behavior)[gesture];
}

/** Strict like rigSendsMessageReceipts: a delivery the daemon ignores would mislabel the message. */
export function rigSupportsFollowUpQueueing(metadata: Metadata | null | undefined): boolean {
    return isRigMetadataV1(metadata) && metadata?.capabilities?.[FOLLOW_UP_QUEUEING_CAPABILITY] === true;
}
