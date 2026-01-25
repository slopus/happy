import type { Metadata, PermissionMode } from '@/api/types';

export type PermissionModeOverride = {
    mode: PermissionMode;
    updatedAt?: number | null;
};

function isValidMessageQueueV1(value: unknown): value is NonNullable<Metadata['messageQueueV1']> {
    if (!value || typeof value !== 'object') return false;
    const v = value as any;
    return v.v === 1 && Array.isArray(v.queue);
}

function resolveMessageQueueV1(opts: {
    current: Metadata['messageQueueV1'] | undefined;
    next: Metadata['messageQueueV1'] | undefined;
}): NonNullable<Metadata['messageQueueV1']> {
    if (isValidMessageQueueV1(opts.current)) return opts.current;
    if (isValidMessageQueueV1(opts.next)) return opts.next;
    return { v: 1, queue: [] };
}

function resolvePermissionModeForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    override?: PermissionModeOverride | null;
}): { mode: PermissionMode; updatedAt: number } | null {
    const currentMode = opts.current.permissionMode;
    const currentAt = typeof opts.current.permissionModeUpdatedAt === 'number' ? opts.current.permissionModeUpdatedAt : null;

    const nextMode = opts.next.permissionMode;
    const nextAt = typeof opts.next.permissionModeUpdatedAt === 'number' ? opts.next.permissionModeUpdatedAt : null;

    let mode: PermissionMode | null = null;
    let updatedAt: number | null = null;

    if (currentMode) {
        mode = currentMode;
        updatedAt = currentAt;
    } else if (nextMode) {
        mode = nextMode;
        updatedAt = nextAt;
    } else {
        return null;
    }

    if (updatedAt === null) {
        updatedAt = opts.nowMs;
    }

    const override = opts.override;
    if (override) {
        const overrideAt = typeof override.updatedAt === 'number' ? override.updatedAt : opts.nowMs;
        if (overrideAt <= updatedAt) {
            if (override.mode === mode) {
                return { mode, updatedAt };
            }
            return { mode: override.mode, updatedAt: updatedAt + 1 };
        }
        return { mode: override.mode, updatedAt: overrideAt };
    }

    return { mode, updatedAt };
}

/**
 * Merge session metadata at process startup (new session or resume attach).
 *
 * Key invariants:
 * - messageQueueV1 is seeded only if missing/invalid; never reset when present.
 * - permissionMode is preserved unless an explicit override is provided.
 * - lifecycleState is set to running.
 */
export function mergeSessionMetadataForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    permissionModeOverride?: PermissionModeOverride | null;
}): Metadata {
    const merged: Metadata = {
        ...opts.current,
        ...opts.next,
        lifecycleState: 'running',
        lifecycleStateSince: opts.nowMs,
    };

    merged.messageQueueV1 = resolveMessageQueueV1({
        current: opts.current.messageQueueV1,
        next: opts.next.messageQueueV1,
    });

    const perm = resolvePermissionModeForStartup({
        current: opts.current,
        next: opts.next,
        nowMs: opts.nowMs,
        override: opts.permissionModeOverride,
    });
    if (perm) {
        merged.permissionMode = perm.mode;
        merged.permissionModeUpdatedAt = perm.updatedAt;
    }

    return merged;
}

