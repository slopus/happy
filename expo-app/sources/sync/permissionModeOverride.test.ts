import { describe, expect, it } from 'vitest';

import { getPermissionModeOverrideForSpawn } from './permissionModeOverride';

describe('getPermissionModeOverrideForSpawn', () => {
    it('returns null when local permissionModeUpdatedAt is missing', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: 'ask',
            // permissionModeUpdatedAt missing
            metadata: { permissionModeUpdatedAt: 1 },
        } as any)).toBeNull();
    });

    it('returns null when local updatedAt is not newer than metadata updatedAt', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: 'ask',
            permissionModeUpdatedAt: 10,
            metadata: { permissionModeUpdatedAt: 10 },
        } as any)).toBeNull();
    });

    it('returns override when local updatedAt is newer than metadata updatedAt', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: 'ask',
            permissionModeUpdatedAt: 11,
            metadata: { permissionModeUpdatedAt: 10 },
        } as any)).toEqual({
            permissionMode: 'ask',
            permissionModeUpdatedAt: 11,
        });
    });

    it('defaults permissionMode to default when local mode is empty', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: '',
            permissionModeUpdatedAt: 11,
            metadata: { permissionModeUpdatedAt: 10 },
        } as any)).toEqual({
            permissionMode: 'default',
            permissionModeUpdatedAt: 11,
        });
    });
});

