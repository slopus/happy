import type { PermissionMode } from '@/sync/permissionTypes';
import type { Session } from './storageTypes';

export type PermissionModeOverrideForSpawn = {
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
};

export function getPermissionModeOverrideForSpawn(session: Session): PermissionModeOverrideForSpawn | null {
    const localUpdatedAt = session.permissionModeUpdatedAt;
    if (typeof localUpdatedAt !== 'number') return null;

    const metadataUpdatedAt = session.metadata?.permissionModeUpdatedAt ?? null;
    const metadataUpdatedAtNumber = typeof metadataUpdatedAt === 'number' ? metadataUpdatedAt : 0;
    if (localUpdatedAt <= metadataUpdatedAtNumber) return null;

    return {
        permissionMode: session.permissionMode || 'default',
        permissionModeUpdatedAt: localUpdatedAt,
    };
}

